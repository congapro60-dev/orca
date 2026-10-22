import { randomUUID } from 'node:crypto'
import type {
  CodexRuntimeRequest,
  CodexRuntimeReceipt
} from '../../../shared/codex-runtime-contract'
import { CodexRuntimeAdapterV0 } from '../../codex/codex-runtime-adapter'
import { CodexRuntimeRequestSchema, prepareCodexRuntime } from '../../codex/codex-runtime-policy'
import { redactString } from '../../observability/redactor'
import type { OrchestrationDb } from './db'
import { CodexExecutionStore, type CodexExecutionRecord } from './codex-execution-store'

/** Native in-process coordinator; no terminal, hook or worker message can settle its execution. */
export class CodexExecutionSupervisor {
  readonly store: CodexExecutionStore
  private readonly pending = new Map<string, Promise<CodexExecutionRecord>>()
  private readonly preparing = new Map<string, AbortController>()
  private readonly persistenceErrors = new Map<string, Error>()

  constructor(
    private readonly native: OrchestrationDb,
    runtimeEpoch: string,
    private readonly adapter = new CodexRuntimeAdapterV0(),
    private readonly prepare = prepareCodexRuntime
  ) {
    this.store = new CodexExecutionStore(native, runtimeEpoch)
    this.store.reconcilePreviousEpoch()
  }

  async start(
    taskId: string,
    input: CodexRuntimeRequest,
    mutationReceipt?:
      | {
          callerFingerprint: string
          requestId: string
          method: string
          payloadHash: string
        }
      | AbortSignal,
    externalSignal?: AbortSignal,
    beforeDispatch?: () => Promise<void>
  ): Promise<CodexExecutionRecord> {
    if (mutationReceipt instanceof AbortSignal) {
      externalSignal = mutationReceipt
      mutationReceipt = undefined
    }
    externalSignal?.throwIfAborted()
    const request = CodexRuntimeRequestSchema.parse(input)
    const task = this.native.getTask(taskId)
    if (!task || task.spec !== request.prompt) {
      throw new Error('Runtime input must match the native Task specification')
    }
    const prepared = await this.prepare(request)
    await beforeDispatch?.()
    externalSignal?.throwIfAborted()
    const executionId = randomUUID()
    const canonical = {
      ...request,
      worktree: prepared.worktree,
      codexHome: prepared.codexHome,
      executablePath: prepared.executable
    }
    this.store.accept(
      taskId,
      executionId,
      prepared.worktree,
      mutationReceipt,
      request.permissionMode
    )
    const preparation = new AbortController()
    const abortPreparation = () => preparation.abort()
    externalSignal?.addEventListener('abort', abortPreparation, { once: true })
    if (externalSignal?.aborted) {
      preparation.abort()
    }
    this.preparing.set(executionId, preparation)
    try {
      await this.adapter.start(canonical, {
        executionId,
        signal: preparation.signal,
        beforeDispatch,
        observe: (snapshot, event) => this.store.save(snapshot, event)
      })
    } catch (error) {
      const receipt: CodexRuntimeReceipt = {
        executionId,
        requestedRuntime: 'codex',
        resolvedExecutablePath: prepared.executable,
        resolvedExecutableVersion: prepared.version,
        runtimeProtocol: 'codex-app-server-jsonrpc-v2',
        requestedModel: request.requestedModel ?? null,
        resolvedModel: null,
        actualModel: 'UNKNOWN_UNVERIFIED',
        effectiveSandbox: 'UNKNOWN_UNVERIFIED',
        approvalPolicy: 'never',
        worktree: prepared.worktree,
        codexHome: prepared.codexHome,
        threadId: null,
        turnId: null
      }
      this.store.save({
        status: preparation.signal.aborted ? 'CANCELLED' : 'FAILED',
        receipt,
        text: '',
        error: redactString(error instanceof Error ? error.message : String(error)).slice(0, 2000)
      })
      return this.store.require(executionId)
    } finally {
      externalSignal?.removeEventListener('abort', abortPreparation)
      this.preparing.delete(executionId)
    }
    const completion = this.adapter
      .result(executionId)
      .then((result) => {
        this.store.save(result)
        return this.store.require(executionId)
      })
      .finally(() => {
        this.pending.delete(executionId)
        this.adapter.release(executionId)
      })
    this.pending.set(executionId, completion)
    void completion.catch((error) => {
      this.persistenceErrors.set(
        executionId,
        error instanceof Error ? error : new Error(String(error))
      )
    })
    return this.store.require(executionId)
  }

  get(executionId: string): CodexExecutionRecord {
    const error = this.persistenceErrors.get(executionId)
    if (error) {
      throw error
    }
    return this.store.require(executionId)
  }

  async result(executionId: string): Promise<CodexExecutionRecord> {
    await this.pending.get(executionId)
    return this.get(executionId)
  }

  async cancel(executionId: string): Promise<void> {
    const current = this.get(executionId)
    if (current.runtimeEpoch !== this.store.runtimeEpoch || current.status === 'OUTCOME_UNKNOWN') {
      throw new Error('Runtime not observable; reconcile before cancellation')
    }
    if (this.pending.has(executionId)) {
      await this.adapter.cancel(executionId)
    } else if (this.preparing.has(executionId)) {
      this.preparing.get(executionId)!.abort()
    }
  }
}
