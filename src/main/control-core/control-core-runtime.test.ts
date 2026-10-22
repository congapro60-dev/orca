import { afterEach, describe, expect, it } from 'vitest'
import { coreFixture } from './control-core-test-fixture'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ControlCoreFacade } from './control-core-facade'
import { checkpointRuntime } from './checkpoint-runtime'
import { CodexExecutionStore } from '../runtime/orchestration/codex-execution-store'
import type { CodexRuntimeReceipt } from '../../shared/codex-runtime-contract'
import { ControlWorkStore } from './control-work-store'
import { attemptCheckpoint } from './attempt-checkpoint'
import { ControlEvidenceStore } from './control-evidence-store'
import { readLatestHandoff, readHandoff } from './handoff-integrity'

const fixtures: ReturnType<typeof coreFixture>[] = []
function setup() {
  const f = coreFixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.dispose()
  }
})

describe('Control Core runtime attempt lifecycle', () => {
  it('refuses permission escalation before reserving a native attempt', async () => {
    const f = setup()
    const { item } = f.create()
    await expect(
      f.core.start(item.workItemId, item.revision, [], {
        runtime: 'codex',
        permissionMode: 'WORKSPACE_WRITE'
      })
    ).rejects.toThrow(/canonical session permission/)
    expect(f.core.item(item.workItemId)).toEqual(item)
    expect(f.db.db.prepare('SELECT COUNT(*) AS n FROM control_work_attempts').get()?.n).toBe(0)
    expect(f.runtime.start).not.toHaveBeenCalled()
  })

  it('uses persisted write permission after reopening and defaults legacy sessions to read-only', async () => {
    const f = setup()
    const legacy = f.create()
    f.db.db
      .prepare('DELETE FROM control_work_session_profiles WHERE session_id=?')
      .run(legacy.session.logicalWorkSessionId)
    const writable = f.core.createSession({
      projectId: 'test',
      worktree: f.directory,
      objective: 'Bounded change',
      permissionMode: 'WORKSPACE_WRITE'
    })
    const core = f.reopen()
    expect(core.openSession(legacy.session.logicalWorkSessionId).session.permissionMode).toBe(
      'READ_ONLY'
    )
    const item = core
      .openSession(writable.logicalWorkSessionId)
      .items.find((row) => row.branchId === 'main')!
    await core.start(item.workItemId, item.revision)
    expect(f.runtime.start.mock.calls[0]?.[1].permissionMode).toBe('WORKSPACE_WRITE')
  })

  it('rejects an invalid session permission atomically', () => {
    const f = setup()
    const runsBefore = f.db.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n
    expect(() =>
      f.core.createSession({
        projectId: 'test',
        worktree: f.directory,
        objective: 'No bypass',
        permissionMode: 'FULL_ACCESS' as never
      })
    ).toThrow()
    expect(f.db.db.prepare('SELECT COUNT(*) AS n FROM control_work_sessions').get()?.n).toBe(0)
    expect(f.db.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(runsBefore)
  })
  it('independently fences a foreign native dispatch permission', () => {
    const f = setup()
    const { session, item } = f.create()
    const task = f.db.createTask({ spec: 'Native boundary test', runId: session.runId })
    f.db.db
      .prepare('INSERT INTO control_work_attempts(task_id,item_id,created_at) VALUES (?,?,?)')
      .run(task.id, item.workItemId, new Date().toISOString())
    const native = new CodexExecutionStore(f.db, 'test-epoch')
    expect(() =>
      native.accept(task.id, randomUUID(), f.directory, undefined, 'WORKSPACE_WRITE')
    ).toThrow(/canonical session permission/)
    expect(f.db.getTask(task.id)?.status).toBe('ready')
    expect(f.db.getDispatchContext(task.id)).toBeUndefined()
  })
  it('serializes admission across logical sessions even on different workspaces', async () => {
    const f = setup()
    const other = setup()
    const { item } = f.create()
    const second = f.core.createSession({
      projectId: 'other-project',
      worktree: other.directory,
      objective: 'Other workspace'
    })
    const secondItem = f.core
      .openSession(second.logicalWorkSessionId)
      .items.find((i) => i.branchId === 'main')!
    const pending = f.core.start(item.workItemId, item.revision)
    await expect(f.core.start(secondItem.workItemId, secondItem.revision)).rejects.toThrow(
      /one WorkItem/
    )
    await pending
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
    await f.core.cancel(item.workItemId)
    expect((await f.core.start(secondItem.workItemId, secondItem.revision)).status).toBe('RUNNING')
  })

  it.each(['FAILED', 'CANCELLED'] as const)(
    'replaces a host-proven %s execution without replacing logical session/item and retains attempt history',
    async (status) => {
      const f = setup()
      const workspace = join(f.directory, 'workspace')
      mkdirSync(workspace)
      const session = f.core.createSession({
        projectId: 'test',
        worktree: workspace,
        objective: 'Recover'
      })
      const item = f.core
        .openSession(session.logicalWorkSessionId)
        .items.find((i) => i.branchId === 'main')!
      const native = () => new CodexExecutionStore(f.db, 'fixture-epoch')
      f.runtime.start.mockImplementation(async (taskId, request) =>
        native().accept(taskId, randomUUID(), request.worktree)
      )
      f.runtime.get.mockImplementation((id) => native().require(id))
      f.runtime.result.mockImplementation(() => new Promise(() => {}))
      const core = new ControlCoreFacade(
        f.db,
        checkpointRuntime(f.db, f.runtime),
        f.environment,
        f.verifier
      )
      const first = await core.start(item.workItemId, item.revision)
      const receipt: CodexRuntimeReceipt = {
        executionId: first.executionId!,
        requestedRuntime: 'codex',
        resolvedExecutablePath: f.environment.executablePath,
        resolvedExecutableVersion: 'fixture',
        runtimeProtocol: 'codex-app-server-jsonrpc-v2',
        requestedModel: null,
        resolvedModel: null,
        actualModel: 'UNKNOWN_UNVERIFIED',
        effectiveSandbox: 'READ_ONLY',
        approvalPolicy: 'never',
        worktree: workspace,
        codexHome: f.environment.codexHome,
        threadId: 'thread',
        turnId: 'turn'
      }
      native().save({
        receipt,
        status,
        text: '',
        error: 'Fixture interruption',
        processObservations: [
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
              childExitCode: 1
            }
          }
        ]
      })
      const failed = core.refresh(item.workItemId)
      const baseline = attemptCheckpoint(
        new ControlWorkStore(f.db),
        item.workItemId,
        first.executionId!
      )
      const original = native().require(first.executionId!)
      const priorEvidence = new ControlEvidenceStore(new ControlWorkStore(f.db)).append({
        logicalWorkSessionId: session.logicalWorkSessionId,
        workItemId: item.workItemId,
        executionId: first.executionId!,
        baseline,
        observed: baseline,
        runtimeReceipt: receipt,
        commands: null,
        tests: null,
        result: 'Original interruption evidence',
        verificationStatus: 'UNVERIFIABLE',
        sourceEvidenceRefs: []
      })
      const originalAttempt = f.db.db
        .prepare('SELECT * FROM control_work_attempts WHERE task_id=?')
        .get(first.nativeTaskId!)
      f.reopen()
      const resumedPort = checkpointRuntime(f.db, f.runtime)
      const recoveredCore = new ControlCoreFacade(
        f.db,
        {
          ...resumedPort,
          start: async (...args) => {
            const execution = await resumedPort.start(...args)
            if (status === 'CANCELLED') {
              throw new Error('Fixture lost replacement receipt')
            }
            return execution
          }
        },
        f.environment,
        f.verifier
      )
      const accepted = await recoveredCore.start(item.workItemId, failed.revision)
      if (status === 'CANCELLED') {
        expect(accepted.status).toBe('BLOCKED')
        expect(accepted.executionId).toBeNull()
      }
      const replacement = recoveredCore
        .openSession(session.logicalWorkSessionId)
        .items.find((row) => row.workItemId === item.workItemId)!
      const handoffWork = new ControlWorkStore(f.db)
      const handoff = readLatestHandoff(handoffWork, item.workItemId)!
      expect(handoff).toMatchObject({
        logicalWorkSessionId: session.logicalWorkSessionId,
        workItemId: item.workItemId,
        sourceExecutionId: first.executionId,
        targetExecutionId: replacement.executionId,
        workspaceHash: baseline?.workspaceHash
      })
      const assignment = recoveredCore
        .events(session.logicalWorkSessionId)
        .find(
          (event) =>
            event.type === 'WORK_ASSIGNED' &&
            event.payload.nativeTaskId === replacement.nativeTaskId
        )!
      const pendingHandoff = readHandoff(
        handoffWork,
        item.workItemId,
        String(assignment.payload.handoffId)
      )
      expect(pendingHandoff.targetExecutionId).toBeNull()
      expect(f.db.getTask(replacement.nativeTaskId!)!.spec).toContain(pendingHandoff.handoffId)
      expect(f.db.getTask(replacement.nativeTaskId!)!.spec).toContain(first.executionId!)
      expect(replacement.logicalWorkSessionId).toBe(session.logicalWorkSessionId)
      expect(replacement.workItemId).toBe(item.workItemId)
      expect(replacement.executionId).not.toBe(first.executionId)
      expect(replacement.nativeTaskId).not.toBe(first.nativeTaskId)
      const attempts = f.db.db
        .prepare('SELECT * FROM control_work_attempts WHERE item_id=? ORDER BY rowid')
        .all(item.workItemId)
      expect(attempts.map((a) => a.execution_id)).toEqual([
        first.executionId,
        replacement.executionId
      ])
      expect(attempts[0]).toEqual(originalAttempt)
      expect(native().require(first.executionId!)).toEqual(original)
      expect(
        new ControlEvidenceStore(new ControlWorkStore(f.db)).get(priorEvidence.evidenceId)
      ).toEqual(priorEvidence)
      expect(
        attemptCheckpoint(new ControlWorkStore(f.db), item.workItemId, first.executionId!)
      ).toEqual(baseline)
      expect(
        attemptCheckpoint(new ControlWorkStore(f.db), item.workItemId, replacement.executionId!)
          ?.workspaceHash
      ).toBe(baseline?.workspaceHash)
      const nextReceipt = { ...receipt, executionId: replacement.executionId! }
      native().save({ receipt: nextReceipt, status: 'RUNNING', text: '', error: null })
      native().save({ receipt: nextReceipt, status: 'COMPLETED', text: 'New result', error: null })
      const recovered = f.reopen().openSession(session.logicalWorkSessionId)
      expect(readLatestHandoff(new ControlWorkStore(f.db), item.workItemId)).toEqual(handoff)
      expect(
        readHandoff(new ControlWorkStore(f.db), item.workItemId, pendingHandoff.handoffId)
      ).toEqual(pendingHandoff)
      expect(recovered.items.find((i) => i.workItemId === item.workItemId)?.status).toBe(
        'READY_FOR_REVIEW'
      )
    }
  )

  it('enforces one active item and rejects stale duplicate start before runtime dispatch', async () => {
    const f = setup()
    const { session, item } = f.create()
    const b = f.core.addBranch(session.logicalWorkSessionId, { objective: 'B', branchId: 'b' })
    await f.core.start(item.workItemId, item.revision)
    await expect(f.core.start(item.workItemId, item.revision)).rejects.toThrow(/Stale/)
    await expect(f.core.start(b.workItemId, b.revision)).rejects.toThrow(/one WorkItem/)
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })

  it('cancels queued work locally and running work through the runtime port', async () => {
    const f = setup()
    const a = f.create()
    expect((await f.core.cancel(a.item.workItemId)).status).toBe('CANCELLED')
    expect(f.runtime.cancel).not.toHaveBeenCalled()
    const b = f.create()
    const running = await f.core.start(b.item.workItemId, b.item.revision)
    expect((await f.core.cancel(b.item.workItemId)).status).toBe('CANCELLED')
    expect(f.runtime.cancel).toHaveBeenCalledWith(running.executionId)
    f.reopen()
    expect(f.core.item(b.item.workItemId).cancelRequested).toBe(true)
  })

  it('propagates cancellation requested while start is preparing', async () => {
    const f = setup()
    const { item } = f.create()
    const original = f.runtime.start.getMockImplementation()!
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    f.runtime.start.mockImplementationOnce(async (...args) => {
      await held
      return original(...args)
    })
    const pending = f.core.start(item.workItemId, item.revision)
    expect(f.core.item(item.workItemId).status).toBe('WAITING')
    await f.core.cancel(item.workItemId)
    release()
    expect((await pending).status).toBe('CANCELLED')
    expect(f.runtime.cancel).toHaveBeenCalledTimes(1)
  })

  it('keeps ambiguous execution BLOCKED and cannot verify or retry it', async () => {
    const f = setup()
    const { item } = f.create()
    const running = await f.core.start(item.workItemId, item.revision)
    f.records.get(running.executionId!)!.status = 'OUTCOME_UNKNOWN'
    const blocked = f.core.refresh(item.workItemId)
    expect(blocked.status).toBe('BLOCKED')
    await expect(f.core.start(item.workItemId, blocked.revision)).rejects.toThrow(/NEEDS_RECONCILE/)
    await expect(f.core.verify(item.workItemId, blocked.revision)).rejects.toThrow(/not ready/)
    const other = setup()
    const next = f.core.createSession({
      projectId: 'other',
      worktree: other.directory,
      objective: 'Other workspace'
    })
    const nextItem = f.core
      .openSession(next.logicalWorkSessionId)
      .items.find((i) => i.branchId === 'main')!
    await expect(f.core.start(nextItem.workItemId, nextItem.revision)).rejects.toThrow(
      /one WorkItem/
    )
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })

  it('rejects foreign workspace receipts and empty completed results', async () => {
    const f = setup()
    const { item } = f.create()
    const running = await f.core.start(item.workItemId, item.revision)
    const record = f.records.get(running.executionId!)!
    record.worktree += '-other'
    expect(() => f.core.refresh(item.workItemId)).toThrow(/canonical WorkItem/)
    record.worktree = f.directory
    record.status = 'COMPLETED'
    record.result = '  '
    expect(() => f.core.refresh(item.workItemId)).toThrow(/no result evidence/)
    expect(f.core.item(item.workItemId).status).toBe('RUNNING')
  })

  it('does not regress RUNNING when a delayed STARTING snapshot arrives', async () => {
    const f = setup()
    const { item } = f.create()
    const running = await f.core.start(item.workItemId, item.revision)
    f.records.get(running.executionId!)!.status = 'STARTING'
    expect(f.core.refresh(item.workItemId).status).toBe('RUNNING')
  })
})
