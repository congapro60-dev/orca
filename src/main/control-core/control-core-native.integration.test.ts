import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CodexRuntimeAdapterV0 } from '../codex/codex-runtime-adapter'
import type { runCodexAppServerSession } from '../codex/codex-app-server-session'
import { CodexExecutionSupervisor } from '../runtime/orchestration/codex-execution-supervisor'
import { ControlCoreFacade } from './control-core-facade'
import { coreFixture } from './control-core-test-fixture'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkpointRuntime } from './checkpoint-runtime'
import { attemptCheckpoint } from './attempt-checkpoint'
import { ControlWorkStore } from './control-work-store'
import { writeProcessObservations } from '../runtime/orchestration/codex-process-observation-store'
import type { CoreRuntimePort } from './control-core-runtime'
import { hasReadOnlyCheckpointEvidence } from './verification-evidence'

const fixtures: ReturnType<typeof coreFixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.dispose()
  }
})

function runtimePort(supervisor: CodexExecutionSupervisor): CoreRuntimePort {
  return {
    start: (taskId, request, signal, _checkpoint, beforeDispatch) =>
      supervisor.start(taskId, request, undefined, signal, beforeDispatch),
    get: (id) => supervisor.get(id),
    result: (id) => supervisor.result(id),
    cancel: (id) => supervisor.cancel(id)
  }
}

function fixture(hold = false, workspaceName?: string) {
  const f = coreFixture()
  fixtures.push(f)
  const worktree = workspaceName ? join(f.directory, workspaceName) : f.directory
  if (workspaceName) {
    mkdirSync(worktree)
  }
  const prepare = vi.fn(async () => ({
    executable: f.environment.executablePath,
    version: 'codex-cli deterministic-protocol',
    worktree,
    codexHome: f.environment.codexHome
  }))
  const methods: string[] = []
  const protocol: typeof runCodexAppServerSession = async (invocation, body) => {
    const threadId = randomUUID()
    const turnId = randomUUID()
    const finish = (status: string) =>
      invocation.onNotification?.('turn/completed', {
        threadId,
        turn: { id: turnId, status }
      })
    return body({
      notify: () => {},
      request: async (method) => {
        methods.push(method)
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
            thread: { id: threadId },
            cwd: worktree,
            model: 'fixture-model',
            approvalPolicy: 'never',
            sandbox: { type: 'readOnly', networkAccess: false }
          }
        }
        if (method === 'turn/start') {
          invocation.onNotification?.('item/completed', {
            threadId,
            turnId,
            item: {
              type: 'agentMessage',
              phase: 'final_answer',
              text: 'Inspected: no modifications'
            }
          })
          if (!hold) {
            finish('completed')
          }
          return { turn: { id: turnId } }
        }
        if (method === 'turn/interrupt') {
          finish('interrupted')
          return {}
        }
        throw new Error(`Unexpected protocol request: ${method}`)
      }
    })
  }
  const adapter = new CodexRuntimeAdapterV0({ prepare, session: protocol })
  const supervisor = new CodexExecutionSupervisor(f.db, 'core-native-one', adapter, prepare)
  const core = new ControlCoreFacade(f.db, runtimePort(supervisor), f.environment, f.verifier)
  const session = core.createSession({
    projectId: 'native-project',
    worktree,
    objective: 'Inspect without changes'
  })
  const item = core
    .openSession(session.logicalWorkSessionId)
    .items.find((i) => i.branchId === 'main')!
  return { f, core, supervisor, session, item, methods, prepare }
}

describe('Control Core through real native supervisor and adapter with deterministic protocol', () => {
  it.each(['supervisor', 'adapter'] as const)(
    'refuses drift while %s preflight is held',
    async (stage) => {
      const { f, item, session, supervisor, prepare, methods } = fixture(
        false,
        'preflight-workspace'
      )
      const normal = prepare.getMockImplementation()!
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      if (stage === 'adapter') {
        prepare.mockImplementationOnce(normal)
      }
      prepare.mockImplementationOnce(async () => {
        await held
        return normal()
      })
      const core = new ControlCoreFacade(
        f.db,
        checkpointRuntime(f.db, runtimePort(supervisor)),
        f.environment,
        f.verifier
      )
      const pending = core.start(item.workItemId, item.revision)
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(stage === 'adapter' ? 2 : 1))
      writeFileSync(join(session.worktree, 'drift.txt'), 'changed during preparation')
      release()
      const started = await pending
      const settled = started.executionId ? await core.wait(item.workItemId) : started
      expect(settled.status).toBe('FAILED')
      expect(methods).not.toContain('turn/start')
      expect(f.db.db.prepare('SELECT count(*) AS n FROM codex_runtime_executions').get()?.n).toBe(
        stage === 'adapter' ? 1 : 0
      )
    }
  )

  it('cancels before native acceptance when preflight is still waiting', async () => {
    const { f, core, item, methods, prepare } = fixture()
    const prepared = {
      executable: f.environment.executablePath,
      version: 'codex-cli fixture',
      worktree: f.directory,
      codexHome: f.environment.codexHome
    }
    let release!: (value: typeof prepared) => void
    prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const pending = core.start(item.workItemId, item.revision)
    await core.cancel(item.workItemId)
    release(prepared)
    const cancelled = await pending
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.executionId).toBeNull()
    expect(f.db.getTask(cancelled.nativeTaskId!)?.status).toBe('failed')
    expect(f.db.db.prepare('SELECT COUNT(*) AS n FROM codex_runtime_executions').get()?.n).toBe(0)
    expect(methods).not.toContain('turn/start')
  })

  it('keeps both native execution results when core review rejects then retries a logical item', async () => {
    const { f, supervisor, session, item } = fixture(false, 'workspace')
    const core = new ControlCoreFacade(
      f.db,
      checkpointRuntime(f.db, runtimePort(supervisor)),
      f.environment,
      f.verifier
    )
    await core.start(item.workItemId, item.revision)
    const first = await core.wait(item.workItemId)
    const baseline = attemptCheckpoint(
      new ControlWorkStore(f.db),
      item.workItemId,
      first.executionId!
    )
    expect(baseline).not.toBeNull()
    writeProcessObservations(f.db, first.executionId!, [
      {
        incarnationId: randomUUID(),
        pid: 77,
        scope: 'owned-process-launcher',
        verdict: 'exited',
        treeVerdict: 'exited',
        observedAt: new Date().toISOString(),
        exitCode: 0,
        signal: null,
        ownedTree: {
          protocol: 'orca-owned-process-v1',
          launcherSha256: 'a'.repeat(64),
          rootPid: 78,
          activeProcesses: 0,
          totalProcesses: 1,
          childExitCode: 0
        }
      }
    ])
    f.verifier.verify.mockResolvedValueOnce({
      passed: false,
      evidenceRefs: ['review:first'],
      reason: 'Rework required'
    })
    const rejected = await core.verify(item.workItemId, first.revision)
    expect(hasReadOnlyCheckpointEvidence(f.db, first)).toBe(false)
    await core.start(item.workItemId, rejected.revision)
    const second = await core.wait(item.workItemId)
    expect(hasReadOnlyCheckpointEvidence(f.db, second)).toBe(true)
    expect(core.latestDecision(item.workItemId)?.status).toBe('ELIGIBLE')
    expect(
      attemptCheckpoint(new ControlWorkStore(f.db), item.workItemId, second.executionId!)
        ?.workspaceHash
    ).toBe(baseline?.workspaceHash)
    expect(second.executionId).not.toBe(first.executionId)
    expect(second.nativeTaskId).not.toBe(first.nativeTaskId)
    expect(supervisor.get(first.executionId!).status).toBe('COMPLETED')
    await core.verify(item.workItemId, second.revision)
    f.reopen()
    const freshSupervisor = new CodexExecutionSupervisor(f.db, 'after-rework')
    const fresh = new ControlCoreFacade(
      f.db,
      runtimePort(freshSupervisor),
      f.environment,
      f.verifier
    )
    expect(fresh.openSession(session.logicalWorkSessionId).session.status).toBe('COMPLETED')
    for (const work of [first, second]) {
      expect(freshSupervisor.get(work.executionId!).result).toBe('Inspected: no modifications')
      expect(f.db.getTask(work.nativeTaskId!)?.result).toBe('Inspected: no modifications')
    }
  })

  it('runs packet -> native Task/Dispatch -> structured result -> host verification, then reopens', async () => {
    const { f, core, supervisor, session, item, methods } = fixture()
    const started = await core.start(item.workItemId, item.revision)
    const ready = await core.wait(item.workItemId)
    expect(ready.status).toBe('READY_FOR_REVIEW')
    const execution = supervisor.get(started.executionId!)
    expect(f.db.getTask(ready.nativeTaskId!)?.result).toBe('Inspected: no modifications')
    expect(f.db.getWorkerDispatch(execution.dispatchId)?.state).toBe('succeeded')
    expect(execution.runId).toBe(session.runId)
    expect(execution.receipt?.actualModel).toBe('UNKNOWN_UNVERIFIED')
    expect(f.db.getTask(ready.nativeTaskId!)?.spec).toContain('ORCA bounded work packet')
    expect(core.openSession(session.logicalWorkSessionId).session.status).toBe('ACTIVE')
    await core.verify(item.workItemId, ready.revision)
    f.reopen()
    const freshSupervisor = new CodexExecutionSupervisor(f.db, 'core-native-two')
    const fresh = new ControlCoreFacade(
      f.db,
      runtimePort(freshSupervisor),
      f.environment,
      f.verifier
    )
    expect(fresh.openSession(session.logicalWorkSessionId).session.status).toBe('COMPLETED')
    expect(freshSupervisor.get(execution.executionId).result).toBe(execution.result)
    expect(methods).not.toContain('worker_done')
  })

  it('propagates cancel through adapter interruption and preserves canonical cancellation', async () => {
    const { f, core, supervisor, item, methods } = fixture(true)
    const start = await core.start(item.workItemId, item.revision)
    await vi.waitFor(() => expect(supervisor.get(start.executionId!).status).toBe('RUNNING'))
    await core.cancel(item.workItemId)
    const cancelled = await core.wait(item.workItemId)
    expect(cancelled.status).toBe('CANCELLED')
    expect(methods).toContain('turn/interrupt')
    expect(f.db.getWorkerDispatch(supervisor.get(start.executionId!).dispatchId)?.state).toBe(
      'stopped'
    )
  })

  it('recovers a native accepted result when the facade never received its execution receipt', async () => {
    const { f, supervisor, session, item } = fixture()
    const lossy = new ControlCoreFacade(
      f.db,
      {
        start: async (taskId, request) => {
          const accepted = await supervisor.start(taskId, request)
          await supervisor.result(accepted.executionId)
          throw new Error('Receipt delivery interrupted')
        },
        get: (id) => supervisor.get(id),
        result: (id) => supervisor.result(id),
        cancel: (id) => supervisor.cancel(id)
      },
      f.environment,
      f.verifier
    )
    const unknown = await lossy.start(item.workItemId, item.revision)
    expect(unknown.status).toBe('BLOCKED')
    expect(unknown.executionId).toBeNull()
    f.reopen()
    const freshSupervisor = new CodexExecutionSupervisor(f.db, 'core-native-two')
    const recovered = new ControlCoreFacade(
      f.db,
      runtimePort(freshSupervisor),
      f.environment,
      f.verifier
    )
    const ready = recovered
      .openSession(session.logicalWorkSessionId)
      .items.find((i) => i.workItemId === item.workItemId)!
    expect(ready.status).toBe('READY_FOR_REVIEW')
    expect(ready.executionId).toBeTruthy()
    expect(
      f.db.db
        .prepare('SELECT execution_id FROM control_work_attempts WHERE task_id=?')
        .get(ready.nativeTaskId!)?.execution_id
    ).toBe(ready.executionId)
    expect(freshSupervisor.get(ready.executionId!).result).toBe('Inspected: no modifications')
  })

  it('recovers an interrupted accepted execution as BLOCKED, never assumes it is alive', async () => {
    const { f, supervisor, session, item } = fixture()
    const interrupted = new ControlCoreFacade(
      f.db,
      {
        start: async (taskId, request) => {
          supervisor.store.accept(taskId, randomUUID(), request.worktree)
          throw new Error('Restart before facade receipt')
        },
        get: (id) => supervisor.get(id),
        result: (id) => supervisor.result(id),
        cancel: (id) => supervisor.cancel(id)
      },
      f.environment,
      f.verifier
    )
    await interrupted.start(item.workItemId, item.revision)
    f.reopen()
    const freshSupervisor = new CodexExecutionSupervisor(f.db, 'core-native-two')
    const fresh = new ControlCoreFacade(
      f.db,
      runtimePort(freshSupervisor),
      f.environment,
      f.verifier
    )
    const work = fresh
      .openSession(session.logicalWorkSessionId)
      .items.find((i) => i.workItemId === item.workItemId)!
    expect(work.status).toBe('BLOCKED')
    expect(freshSupervisor.get(work.executionId!).status).toBe('OUTCOME_UNKNOWN')
    await expect(fresh.start(work.workItemId, work.revision)).rejects.toThrow(/NEEDS_RECONCILE/)
    const other = coreFixture()
    fixtures.push(other)
    const next = fresh.createSession({
      projectId: 'next-project',
      worktree: other.directory,
      objective: 'Must not overlap unknown execution'
    })
    const nextItem = fresh
      .openSession(next.logicalWorkSessionId)
      .items.find((i) => i.branchId === 'main')!
    const startSpy = vi.spyOn(freshSupervisor, 'start')
    await expect(fresh.start(nextItem.workItemId, nextItem.revision)).rejects.toThrow(
      /one WorkItem/
    )
    expect(startSpy).not.toHaveBeenCalled()
  })
})
