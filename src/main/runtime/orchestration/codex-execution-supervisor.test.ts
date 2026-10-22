import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from './db'
import { CodexExecutionSupervisor } from './codex-execution-supervisor'
import { CodexRuntimeAdapterV0 } from '../../codex/codex-runtime-adapter'
import type { runCodexAppServerSession } from '../../codex/codex-app-server-session'
import type { CodexRuntimeRequest } from '../../../shared/codex-runtime-contract'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function fixture(
  options: { hold?: boolean; fail?: boolean; disconnect?: boolean; writable?: boolean } = {}
) {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const request: CodexRuntimeRequest = {
    prompt: 'Inspect clean repository',
    worktree: join(tmpdir(), 'supervisor-repo'),
    executablePath: join(tmpdir(), 'installed', 'codex.exe'),
    codexHome: join(tmpdir(), 'profile'),
    permissionMode: options.writable ? 'WORKSPACE_WRITE' : 'READ_ONLY',
    approvalPolicy: 'never'
  }
  const prepare = vi.fn(async () => ({
    executable: request.executablePath,
    version: 'codex-cli test',
    worktree: request.worktree,
    codexHome: request.codexHome
  }))
  const protocolMethods: string[] = []
  const session: typeof runCodexAppServerSession = async (invocation, body) => {
    const emit = (status: string) =>
      invocation.onNotification?.('turn/completed', {
        threadId: 'thread-live',
        turn: {
          id: 'turn-live',
          status,
          ...(status === 'failed' ? { error: { message: 'bounded failure' } } : {})
        }
      })
    return body({
      notify: () => {},
      request: async (method, params) => {
        protocolMethods.push(method)
        if (method === 'account/read') {
          return { account: { type: 'chatgpt' } }
        }
        if (method === 'hooks/list') {
          return { data: [{ hooks: [] }] }
        }
        if (method === 'mcpServerStatus/list') {
          return { data: [], nextCursor: null }
        }
        if (method === 'config/read') {
          return { config: {} }
        }
        if (method === 'thread/start') {
          return {
            thread: { id: 'thread-live' },
            cwd: request.worktree,
            model: 'reported-model',
            approvalPolicy: 'never',
            sandbox: options.writable
              ? {
                  type: 'workspaceWrite',
                  networkAccess: false,
                  writableRoots: [request.worktree],
                  excludeSlashTmp: true,
                  excludeTmpdirEnvVar: true
                }
              : { type: 'readOnly', networkAccess: false }
          }
        }
        if (method === 'turn/start') {
          invocation.onProcessObservation?.({
            incarnationId: 'fixture-process',
            pid: 77,
            scope: 'app-server-child',
            verdict: 'live',
            observedAt: new Date().toISOString(),
            exitCode: null,
            signal: null
          })
          const before = db.db.prepare('SELECT COUNT(*) AS n FROM codex_runtime_executions').get()
          expect(before?.n).toBe(1)
          expect(params?.input).toEqual([{ type: 'text', text: request.prompt }])
          if (options.disconnect) {
            throw new Error('Lost transport after submit')
          }
          invocation.onNotification?.('item/completed', {
            threadId: 'thread-live',
            turnId: 'turn-live',
            item: {
              id: 'command-live',
              type: 'commandExecution',
              command: 'git status',
              status: 'completed',
              exitCode: 0
            }
          })
          invocation.onNotification?.('item/completed', {
            threadId: 'thread-live',
            turnId: 'turn-live',
            item: {
              type: 'agentMessage',
              phase: 'final_answer',
              text: options.fail ? '' : 'Actual structured answer'
            }
          })
          if (!options.hold) {
            emit(options.fail ? 'failed' : 'completed')
            invocation.onProcessObservation?.({
              incarnationId: 'fixture-process',
              pid: 77,
              scope: 'app-server-child',
              verdict: 'exited',
              observedAt: new Date().toISOString(),
              exitCode: 0,
              signal: null
            })
          }
          return { turn: { id: 'turn-live' } }
        }
        if (method === 'turn/interrupt') {
          emit('interrupted')
          return {}
        }
        throw new Error(`Unexpected ${method}`)
      }
    })
  }
  const adapter = new CodexRuntimeAdapterV0({ prepare, session })
  const supervisor = new CodexExecutionSupervisor(db, 'epoch-test', adapter, prepare)
  const run = db.createRun({
    objective: request.prompt,
    coordinatorHandle: 'core',
    coordinatorPaneKey: 'core'
  })
  const task = db.createTask({ spec: request.prompt, runId: run.id })
  return { db, supervisor, task, request, protocolMethods, prepare }
}

describe('Native Codex execution supervisor', () => {
  it('persists a WORKSPACE_WRITE lifecycle through the real adapter and native store', async () => {
    const { db, supervisor, task, request } = fixture({ writable: true })
    const row = await supervisor.start(task.id, request)
    const result = await supervisor.result(row.executionId)
    expect(result).toMatchObject({
      status: 'COMPLETED',
      receipt: { effectiveSandbox: 'WORKSPACE_WRITE' }
    })
    expect(db.getWorkerDispatch(row.dispatchId)?.state).toBe('succeeded')
  })
  it('carries early command evidence through the adapter into native persistence', async () => {
    const { supervisor, task, request } = fixture()
    const row = await supervisor.start(task.id, request)
    const result = await supervisor.result(row.executionId)
    expect(result.commands).toEqual([
      { itemId: 'command-live', command: 'git status', status: 'completed', exitCode: 0 }
    ])
    expect(result.processObservations?.at(-1)).toMatchObject({
      verdict: 'exited',
      scope: 'app-server-child'
    })
    expect(result.processObservations?.[0].incarnationId).toBeDefined()
  })
  it('does not accept or start an execution cancelled during preflight', async () => {
    const { supervisor, db, task, request, prepare, protocolMethods } = fixture()
    let release!: (value: {
      executable: string
      version: string
      worktree: string
      codexHome: string
    }) => void
    prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const controller = new AbortController()
    const pending = supervisor.start(task.id, request, undefined, controller.signal)
    controller.abort()
    release({
      executable: request.executablePath,
      version: 'codex-cli test',
      worktree: request.worktree,
      codexHome: request.codexHome
    })
    await expect(pending).rejects.toThrow()
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM codex_runtime_executions').get()?.n).toBe(0)
    expect(protocolMethods).not.toContain('turn/start')
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('fences legacy stop/abandon and reset while a programmatic turn is held', async () => {
    const { db, supervisor, task, request } = fixture({ hold: true })
    const row = await supervisor.start(task.id, request)
    await vi.waitFor(() => expect(supervisor.get(row.executionId).status).toBe('RUNNING'))
    expect(() => db.beginWorkerStop(row.dispatchId, 'epoch-test')).toThrow(/terminal stop/)
    expect(() => db.abandonWorkerDispatch(row.dispatchId)).toThrow(/terminal stop/)
    expect(() => db.resetTasks()).toThrow(/Cannot reset/)
    expect(() => db.resetAll()).toThrow(/Cannot reset/)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(supervisor.get(row.executionId).status).toBe('RUNNING')
    await supervisor.cancel(row.executionId)
    expect((await supervisor.result(row.executionId)).status).toBe('CANCELLED')
  })

  it('honors cancellation while the accepted execution is still preparing', async () => {
    const { db, supervisor, task, request, prepare, protocolMethods } = fixture()
    const prepared = {
      executable: request.executablePath,
      version: 'codex-cli test',
      worktree: request.worktree,
      codexHome: request.codexHome
    }
    let resolvePreparation!: (value: typeof prepared) => void
    prepare.mockResolvedValueOnce(prepared).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve
        })
    )
    const start = supervisor.start(task.id, request)
    let id = ''
    await vi.waitFor(() => {
      const row = db.db.prepare('SELECT execution_id FROM codex_runtime_executions').get()
      expect(row).toBeTruthy()
      id = row!.execution_id as string
    })
    await supervisor.cancel(id)
    resolvePreparation(prepared)
    expect((await start).status).toBe('CANCELLED')
    expect(protocolMethods).not.toContain('turn/start')
    expect(db.getWorkerDispatch(supervisor.get(id).dispatchId)?.state).toBe('stopped')
  })
  it('drives a real adapter/fake protocol into native Run/Task/Dispatch and result', async () => {
    const { db, supervisor, task, request, protocolMethods } = fixture()
    const accepted = await supervisor.start(task.id, request)
    const finished = await supervisor.result(accepted.executionId)
    expect(finished).toMatchObject({
      status: 'COMPLETED',
      taskId: task.id,
      result: 'Actual structured answer',
      receipt: { threadId: 'thread-live', turnId: 'turn-live', actualModel: 'UNKNOWN_UNVERIFIED' }
    })
    expect(db.getTask(task.id)).toMatchObject({ status: 'completed', result: finished.result })
    expect(db.getWorkerDispatch(finished.dispatchId)?.state).toBe('succeeded')
    expect(supervisor.store.events(accepted.executionId).map((e) => e.method)).toContain(
      'turn/submitting'
    )
    expect(protocolMethods).not.toContain('worker_done')
  })

  it('records a failed structured turn, not a successful task', async () => {
    const { db, supervisor, task, request } = fixture({ fail: true })
    const row = await supervisor.start(task.id, request)
    expect(await supervisor.result(row.executionId)).toMatchObject({
      status: 'FAILED',
      error: 'bounded failure'
    })
    expect(db.getTask(task.id)?.status).toBe('failed')
  })

  it('persists cancel request and structured interruption', async () => {
    const { db, supervisor, task, request } = fixture({ hold: true })
    const row = await supervisor.start(task.id, request)
    await vi.waitFor(() => expect(supervisor.get(row.executionId).status).toBe('RUNNING'))
    await supervisor.cancel(row.executionId)
    expect((await supervisor.result(row.executionId)).status).toBe('CANCELLED')
    expect(db.getWorkerDispatch(row.dispatchId)?.state).toBe('stopped')
    expect(supervisor.store.events(row.executionId).map((e) => e.method)).toContain(
      'turn/interruptRequested'
    )
  })

  it('blocks the canonical task on ambiguous transport loss', async () => {
    const { db, supervisor, task, request } = fixture({ disconnect: true })
    const row = await supervisor.start(task.id, request)
    expect((await supervisor.result(row.executionId)).status).toBe('OUTCOME_UNKNOWN')
    expect(db.getTask(task.id)?.status).toBe('blocked')
    await expect(supervisor.cancel(row.executionId)).rejects.toThrow(/not observable/)
  })

  it('refuses a prompt differing from canonical native Task before executable discovery', async () => {
    const { supervisor, task, request, prepare } = fixture()
    await expect(
      supervisor.start(task.id, { ...request, prompt: 'Unrelated work' })
    ).rejects.toThrow(/native Task/)
    expect(prepare).not.toHaveBeenCalled()
  })
})
