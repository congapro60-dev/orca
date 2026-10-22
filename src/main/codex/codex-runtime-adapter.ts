import { randomUUID } from 'node:crypto'
import type {
  CodexRuntimeRequest,
  CodexRuntimeReceipt,
  CodexRuntimeEvent,
  CodexRuntimeResult
} from '../../shared/codex-runtime-contract'
import { runCodexAppServerSession, type CodexAppServerRpc } from './codex-app-server-session'
import {
  CodexRuntimeRequestSchema,
  prepareCodexRuntime,
  codexRuntimeEnvironment,
  checkedCodexThread,
  codexSandboxPolicy,
  codexSandboxConfig,
  TurnReceiptSchema
} from './codex-runtime-policy'
import { codexRuntimePreflight, verifyCodexRuntimeTools } from './codex-runtime-preflight'
import { CodexRuntimeTurnEvents } from './codex-runtime-turn-events'
import { codexRuntimeMcpOverrides } from './codex-runtime-mcp-overrides'
import { codexRuntimeError, codexTurnError } from './codex-runtime-error'
import { runManagedCodexSession } from './codex-runtime-session'

const MAX_EVENTS = 256
type Execution = {
  result: CodexRuntimeResult
  events: CodexRuntimeEvent[]
  sequence: number
  controller: AbortController
  rpc?: CodexAppServerRpc
  cancelRequested: boolean
  completion: Promise<CodexRuntimeResult>
  settle: (value: CodexRuntimeResult) => void
  observe?: (snapshot: CodexRuntimeResult, event: CodexRuntimeEvent) => void
  detachAbort?: () => void
}

export type CodexRuntimeStartOptions = {
  executionId?: string
  observe?: Execution['observe']
  signal?: AbortSignal
  beforeDispatch?: () => Promise<void>
}

export class CodexRuntimeAdapterV0 {
  private readonly executions = new Map<string, Execution>()

  constructor(
    private readonly dependencies = {
      prepare: prepareCodexRuntime,
      session: runCodexAppServerSession
    }
  ) {}

  async start(
    input: CodexRuntimeRequest,
    options: CodexRuntimeStartOptions = {}
  ): Promise<CodexRuntimeReceipt> {
    const request = CodexRuntimeRequestSchema.parse(input)
    options.signal?.throwIfAborted()
    const executionId = options.executionId ?? randomUUID()
    if (!/^[a-f0-9-]{36}$/i.test(executionId) || this.executions.has(executionId)) {
      throw new Error('Invalid or duplicate Codex execution identity')
    }
    const prepared = await this.dependencies.prepare(request)
    options.signal?.throwIfAborted()
    if (this.executions.has(executionId)) {
      throw new Error('Duplicate Codex execution identity')
    }
    if (this.executions.size >= 32) {
      throw new Error('Codex execution retention limit reached')
    }
    let settle!: Execution['settle']
    const completion = new Promise<CodexRuntimeResult>((resolve) => {
      settle = resolve
    })
    const execution: Execution = {
      result: {
        status: 'STARTING',
        text: '',
        error: null,
        receipt: {
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
      },
      events: [],
      sequence: 0,
      controller: new AbortController(),
      cancelRequested: false,
      completion,
      settle,
      observe: options.observe
    }
    this.executions.set(execution.result.receipt.executionId, execution)
    if (options.signal) {
      const signal = options.signal
      const abort = () => {
        execution.cancelRequested = true
        execution.controller.abort()
      }
      signal.addEventListener('abort', abort, { once: true })
      execution.detachAbort = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) {
        abort()
      }
    }
    try {
      this.append(execution, 'STARTING', 'execution/start')
    } catch (error) {
      this.executions.delete(executionId)
      execution.detachAbort?.()
      throw error
    }
    void this.execute(execution, request, options.beforeDispatch)
    return structuredClone(execution.result.receipt)
  }

  getStatus(executionId: string): CodexRuntimeResult {
    return structuredClone(this.require(executionId).result)
  }

  events(executionId: string, after = 0) {
    const execution = this.require(executionId)
    return {
      events: structuredClone(execution.events.filter((event) => event.sequence > after)),
      truncated: after < (execution.events[0]?.sequence ?? 1) - 1,
      lastSequence: execution.sequence
    }
  }

  async result(executionId: string): Promise<CodexRuntimeResult> {
    return structuredClone(await this.require(executionId).completion)
  }

  async cancel(executionId: string): Promise<void> {
    const execution = this.require(executionId)
    if (['STARTING', 'RUNNING'].includes(execution.result.status)) {
      execution.cancelRequested = true
      this.append(execution, 'PROGRESS', 'turn/interruptRequested')
      const { threadId, turnId } = execution.result.receipt
      if (!threadId || !turnId || !execution.rpc) {
        execution.controller.abort()
      } else {
        await execution.rpc.request('turn/interrupt', { threadId, turnId })
      }
    }
  }

  release(executionId: string): void {
    if (['STARTING', 'RUNNING'].includes(this.require(executionId).result.status)) {
      throw new Error('Cannot release an active Codex execution')
    }
    this.executions.delete(executionId)
  }

  private require(id: string): Execution {
    const value = this.executions.get(id)
    if (!value) {
      throw new Error('Unknown Codex execution')
    }
    return value
  }

  private append(
    execution: Execution,
    kind: CodexRuntimeEvent['kind'],
    method: string,
    itemType?: string
  ) {
    execution.events.push({
      sequence: ++execution.sequence,
      at: new Date().toISOString(),
      kind,
      method: method.slice(0, 128),
      ...(itemType ? { itemType: itemType.slice(0, 80) } : {})
    })
    execution.events.splice(0, Math.max(0, execution.events.length - MAX_EVENTS))
    execution.observe?.(
      structuredClone(execution.result),
      structuredClone(execution.events.at(-1)!)
    )
  }

  private async execute(
    execution: Execution,
    request: CodexRuntimeRequest,
    beforeDispatch?: () => Promise<void>
  ): Promise<void> {
    const receipt = execution.result.receipt
    let turnSubmitted = false
    const turns = new CodexRuntimeTurnEvents(receipt, (method, itemType) =>
      this.append(execution, 'PROGRESS', method, itemType)
    )
    try {
      const mcpOverrides = await codexRuntimeMcpOverrides(receipt.codexHome)
      const session = this.dependencies.session
      await (session === runCodexAppServerSession ? runManagedCodexSession : session)(
        {
          command: receipt.resolvedExecutablePath,
          cliPath: receipt.resolvedExecutablePath,
          args: [
            'app-server',
            '--stdio',
            '--config=model_provider="openai"',
            '--disable',
            'apps',
            '--disable',
            'plugins',
            ...mcpOverrides.args
          ],
          cwd: receipt.worktree,
          env: codexRuntimeEnvironment(receipt.codexHome),
          inheritEnv: false,
          timeoutMs: request.timeoutMs ?? 120000,
          signal: execution.controller.signal,
          onNotification: (method, value) => turns.accept(method, value),
          onProcessObservation: (observation) =>
            (execution.result.processObservations ??= []).push(observation)
        },
        async (rpc) => {
          execution.rpc = rpc
          const config = await codexRuntimePreflight(rpc, receipt.worktree, mcpOverrides.names)
          const thread = checkedCodexThread(
            await rpc.request('thread/start', {
              cwd: receipt.worktree,
              sandbox:
                request.permissionMode === 'WORKSPACE_WRITE' ? 'workspace-write' : 'read-only',
              approvalPolicy: 'never',
              modelProvider: 'openai',
              ephemeral: true,
              allowProviderModelFallback: false,
              config: {
                ...config,
                ...codexSandboxConfig(request.permissionMode, receipt.worktree)
              },
              ...(request.requestedModel ? { model: request.requestedModel } : {})
            }),
            request.permissionMode,
            receipt.worktree
          )
          receipt.threadId = thread.thread.id
          receipt.resolvedModel = thread.model ?? null
          receipt.effectiveSandbox = request.permissionMode
          this.append(execution, 'PROGRESS', 'thread/start')
          await verifyCodexRuntimeTools(rpc, receipt.threadId, mcpOverrides.names)
          await beforeDispatch?.()
          execution.controller.signal.throwIfAborted()
          turnSubmitted = true
          this.append(execution, 'PROGRESS', 'turn/submitting')
          const started = TurnReceiptSchema.parse(
            await rpc.request('turn/start', {
              threadId: receipt.threadId,
              input: [{ type: 'text', text: request.prompt }],
              cwd: receipt.worktree,
              approvalPolicy: 'never',
              sandboxPolicy: codexSandboxPolicy(request.permissionMode, receipt.worktree)
            })
          )
          receipt.turnId = started.turn.id
          execution.result.status = 'RUNNING'
          this.append(execution, 'RUNNING', 'turn/start')
          if (execution.cancelRequested) {
            await rpc.request('turn/interrupt', {
              threadId: receipt.threadId,
              turnId: receipt.turnId
            })
          }
          const done = await turns.wait()
          execution.result.text = turns.resultText()
          if (done.status === 'completed' && execution.result.text.trim()) {
            execution.result.status = 'COMPLETED'
          } else if (done.status === 'interrupted') {
            execution.result.status = 'CANCELLED'
          } else {
            execution.result.status = 'FAILED'
            execution.result.error = codexTurnError(done)
          }
        }
      )
    } catch (error) {
      execution.result.status = turnSubmitted
        ? 'OUTCOME_UNKNOWN'
        : execution.cancelRequested
          ? 'CANCELLED'
          : 'FAILED'
      execution.result.error = codexRuntimeError(error)
    } finally {
      execution.result.commands = turns.commandEvidence()
      execution.detachAbort?.()
      execution.rpc = undefined
      try {
        this.append(execution, 'TERMINAL', 'execution/settled')
      } catch (error) {
        execution.result.status = 'OUTCOME_UNKNOWN'
        execution.result.error = codexRuntimeError(error)
      }
      execution.settle(structuredClone(execution.result))
    }
  }
}
