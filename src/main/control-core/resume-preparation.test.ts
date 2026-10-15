import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CodexRuntimeReceipt } from '../../shared/codex-runtime-contract'
import { CodexExecutionStore } from '../runtime/orchestration/codex-execution-store'
import { writeProcessObservations } from '../runtime/orchestration/codex-process-observation-store'
import { coreFixture } from './control-core-test-fixture'
import { ControlCoreFacade } from './control-core-facade'
import { ControlWorkStore } from './control-work-store'
import { ControlEvidenceStore } from './control-evidence-store'
import { checkpointRuntime } from './checkpoint-runtime'
import * as capture from './workspace-checkpoint'

const fixtures: ReturnType<typeof coreFixture>[] = []
afterEach(() => {
  vi.restoreAllMocks()
  fixtures.splice(0).forEach((f) => f.dispose())
})

async function setup(status: 'FAILED' | 'CANCELLED' | 'OUTCOME_UNKNOWN' = 'FAILED') {
  const f = coreFixture()
  fixtures.push(f)
  const workspace = join(f.directory, 'workspace')
  mkdirSync(workspace)
  const session = f.core.createSession({
    projectId: 'test',
    worktree: workspace,
    objective: 'Retry'
  })
  const queued = f.core
    .openSession(session.logicalWorkSessionId)
    .items.find((i) => i.branchId === 'main')!
  const native = new CodexExecutionStore(f.db, 'fixture-epoch')
  f.runtime.start.mockImplementation(async (taskId, request) =>
    native.accept(taskId, randomUUID(), request.worktree)
  )
  f.runtime.get.mockImplementation((id) => native.require(id))
  f.runtime.result.mockImplementation(() => new Promise(() => {}))
  const core = new ControlCoreFacade(
    f.db,
    checkpointRuntime(f.db, f.runtime),
    f.environment,
    f.verifier
  )
  const started = await core.start(queued.workItemId, queued.revision)
  const receipt: CodexRuntimeReceipt = {
    executionId: started.executionId!,
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
  native.save({ receipt, status, text: '', error: 'Fixture interruption' })
  const item = core.refresh(queued.workItemId)
  const work = new ControlWorkStore(f.db)
  return { f, core, item, workspace, work, evidence: new ControlEvidenceStore(work) }
}

function prove({ f, item }: Awaited<ReturnType<typeof setup>>, legacy = false) {
  writeProcessObservations(f.db, item.executionId!, [
    {
      incarnationId: randomUUID(),
      pid: 77,
      scope: legacy ? 'app-server-child' : 'owned-process-launcher',
      verdict: 'exited',
      treeVerdict: 'exited',
      observedAt: new Date().toISOString(),
      exitCode: 0,
      signal: null,
      ...(legacy
        ? {}
        : {
            ownedTree: {
              protocol: 'orca-owned-process-v1' as const,
              launcherSha256: 'a'.repeat(64),
              rootPid: 78,
              activeProcesses: 0 as const,
              totalProcesses: 1,
              childExitCode: 1
            }
          })
    }
  ])
}

function attempts(f: ReturnType<typeof coreFixture>) {
  return f.db.db.prepare('SELECT * FROM control_work_attempts ORDER BY rowid').all()
}

describe('Core repeat-start admission', () => {
  it('releases a proven unknown source for one new attempt without rewriting its outcome', async () => {
    const state = await setup('OUTCOME_UNKNOWN')
    prove(state)
    const { f, core, item, workspace } = state
    const original = new CodexExecutionStore(f.db, 'fixture-epoch').require(item.executionId!)
    const replacement = await core.start(item.workItemId, item.revision)
    expect(replacement.executionId).not.toBe(item.executionId)
    expect(replacement.workItemId).toBe(item.workItemId)
    expect(replacement.logicalWorkSessionId).toBe(item.logicalWorkSessionId)
    expect(new CodexExecutionStore(f.db, 'fixture-epoch').require(item.executionId!)).toEqual(
      original
    )
    const release = f.db.db
      .prepare('SELECT recovery_decision_id FROM codex_runtime_executions WHERE execution_id=?')
      .get(item.executionId!)!
    expect(release.recovery_decision_id).toBeTruthy()
    const extra = f.db.createTask({ spec: 'Must not overlap', runId: original.runId })
    expect(() =>
      new CodexExecutionStore(f.db, 'fixture-epoch').accept(extra.id, randomUUID(), workspace)
    ).toThrow()
    expect(attempts(f)).toHaveLength(2)
    f.reopen()
    expect(new CodexExecutionStore(f.db, 'after-restart').require(item.executionId!)).toEqual(
      original
    )
    expect(
      f.db.db
        .prepare('SELECT recovery_decision_id FROM codex_runtime_executions WHERE execution_id=?')
        .get(item.executionId!)
    ).toEqual(release)
  })

  it.each(['missing', 'tampered', 'drift'] as const)(
    'keeps unknown source quarantined with %s evidence',
    async (fault) => {
      const state = await setup('OUTCOME_UNKNOWN')
      if (fault !== 'missing') {
        prove(state)
      }
      const { f, core, item, workspace } = state
      if (fault === 'tampered') {
        f.db.db.prepare('UPDATE codex_runtime_process_observations SET content_hash=NULL').run()
      } else if (fault === 'drift') {
        writeFileSync(join(workspace, 'changed.txt'), 'drift')
      }
      await expect(core.start(item.workItemId, item.revision)).rejects.toThrow(
        /NEEDS_RECONCILE|STALE_CHECKPOINT/
      )
      expect(core.item(item.workItemId)).toEqual(item)
      expect(attempts(f)).toHaveLength(1)
      expect(
        f.db.db
          .prepare('SELECT recovery_decision_id FROM codex_runtime_executions WHERE execution_id=?')
          .get(item.executionId!)?.recovery_decision_id
      ).toBeNull()
    }
  )

  it('does not trust a forged release marker at native acceptance', async () => {
    const { f, item, workspace, evidence } = await setup('OUTCOME_UNKNOWN')
    const fake = evidence.decision({
      workItemId: item.workItemId,
      sourceExecutionId: item.executionId,
      status: 'ELIGIBLE',
      processVerdict: 'exited',
      baselineCheckpointId: null,
      observedCheckpointId: null,
      reason: 'Forged host proof in fixture'
    })
    f.db.db
      .prepare('UPDATE codex_runtime_executions SET recovery_decision_id=? WHERE execution_id=?')
      .run(fake.decisionId, item.executionId)
    const source = new CodexExecutionStore(f.db, 'fixture-epoch').require(item.executionId!)
    const task = f.db.createTask({ spec: 'Must refuse', runId: source.runId })
    expect(() =>
      new CodexExecutionStore(f.db, 'fixture-epoch').accept(task.id, randomUUID(), workspace)
    ).toThrow(/recovery proof/)
    expect(f.db.getTask(task.id)?.status).toBe('ready')
    expect(f.db.getDispatchContext(task.id)).toBeUndefined()
    expect(new CodexExecutionStore(f.db, 'fixture-epoch').require(item.executionId!)).toEqual(
      source
    )
  })

  it.each(['decision', 'process', 'checkpoint'] as const)(
    'rejects corrupted %s evidence after a release was recorded',
    async (fault) => {
      const state = await setup('OUTCOME_UNKNOWN')
      prove(state)
      const { f, core, item, evidence, workspace } = state
      const runId = core.openSession(item.logicalWorkSessionId).session.runId
      const baseline = evidence.latestCheckpoint(item.workItemId)!
      const decision = core.reconcileResume({
        workItemId: item.workItemId,
        sourceExecutionId: item.executionId,
        observed: baseline
      })
      expect(decision.status).toBe('ELIGIBLE')
      f.db.db
        .prepare('UPDATE codex_runtime_executions SET recovery_decision_id=? WHERE execution_id=?')
        .run(decision.decisionId, item.executionId)
      if (fault === 'decision') {
        f.db.db
          .prepare('UPDATE control_resume_decisions SET content_hash=NULL WHERE id=?')
          .run(decision.decisionId)
      } else if (fault === 'process') {
        f.db.db
          .prepare(
            'UPDATE codex_runtime_process_observations SET content_hash=NULL WHERE execution_id=?'
          )
          .run(item.executionId)
      } else {
        f.db.db
          .prepare('UPDATE control_workspace_checkpoints SET content_hash=NULL WHERE id=?')
          .run(baseline.checkpointId)
      }
      const task = f.db.createTask({ spec: 'Must remain fenced', runId })
      expect(() =>
        new CodexExecutionStore(f.db, 'fixture-epoch').accept(task.id, randomUUID(), workspace)
      ).toThrow()
      expect(f.db.getTask(task.id)?.status).toBe('ready')
      expect(f.db.getDispatchContext(task.id)).toBeUndefined()
    }
  )

  it('upgrades the legacy workspace index without releasing historical unknown executions', async () => {
    const { f, item, workspace } = await setup('OUTCOME_UNKNOWN')
    const original = new CodexExecutionStore(f.db, 'fixture-epoch').require(item.executionId!)
    f.db.db.exec(`DROP INDEX idx_codex_active_worktree;
      ALTER TABLE codex_runtime_executions DROP COLUMN recovery_decision_id;
      CREATE UNIQUE INDEX idx_codex_active_worktree ON codex_runtime_executions(worktree)
      WHERE status IN ('STARTING','RUNNING','OUTCOME_UNKNOWN')`)
    f.reopen()
    const migrated = new CodexExecutionStore(f.db, 'after-migration')
    expect(migrated.require(item.executionId!)).toEqual(original)
    expect(
      f.db.db
        .prepare('SELECT recovery_decision_id FROM codex_runtime_executions WHERE execution_id=?')
        .get(item.executionId!)?.recovery_decision_id
    ).toBeNull()
    const task = f.db.createTask({ spec: 'Still quarantined', runId: original.runId })
    expect(() => migrated.accept(task.id, randomUUID(), workspace)).toThrow(
      /trusted recovery release/
    )
    expect(f.db.getTask(task.id)?.status).toBe('ready')
  })

  it.each(['FAILED', 'CANCELLED'] as const)(
    'refuses %s with no host proof below the UI',
    async (status) => {
      const { f, core, item } = await setup(status)
      await expect(core.start(item.workItemId, item.revision)).rejects.toThrow(/INTERRUPTED/)
      expect(core.item(item.workItemId)).toEqual(item)
      expect(attempts(f)).toHaveLength(1)
      expect(f.runtime.start).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    'legacy process',
    'unhashed process',
    'tampered process',
    'missing baseline',
    'legacy baseline',
    'tampered baseline',
    'drift'
  ])('refuses %s without reserving a new attempt', async (fault) => {
    const state = await setup()
    const { f, core, item, workspace } = state
    prove(state, fault === 'legacy process')
    if (fault === 'unhashed process') {
      f.db.db.prepare('UPDATE codex_runtime_process_observations SET content_hash=NULL').run()
    } else if (fault === 'tampered process') {
      f.db.db
        .prepare(
          "UPDATE codex_runtime_process_observations SET snapshot=json_set(snapshot,'$[0].ownedTree.rootPid',99)"
        )
        .run()
    } else if (fault === 'missing baseline') {
      f.db.db.prepare('DELETE FROM control_attempt_checkpoints').run()
    } else if (fault === 'legacy baseline') {
      f.db.db.prepare('UPDATE control_workspace_checkpoints SET content_hash=NULL').run()
    } else if (fault === 'tampered baseline') {
      f.db.db
        .prepare(
          "UPDATE control_workspace_checkpoints SET snapshot=json_set(snapshot,'$.workspaceHash','tampered')"
        )
        .run()
    } else if (fault === 'drift') {
      writeFileSync(join(workspace, 'changed.txt'), 'drift')
    }
    await expect(core.start(item.workItemId, item.revision)).rejects.toThrow(
      /INTERRUPTED|NEEDS_RECONCILE|STALE_CHECKPOINT|integrity/
    )
    expect(core.item(item.workItemId)).toEqual(item)
    expect(attempts(f)).toHaveLength(1)
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })

  it('rejects stale revision before capture or evidence writes', async () => {
    const state = await setup()
    prove(state)
    const { core, item, evidence } = state
    const checkpoint = evidence.latestCheckpoint(item.workItemId)
    const spy = vi.spyOn(capture, 'captureWorkspaceCheckpoint')
    await expect(core.start(item.workItemId, item.revision - 1)).rejects.toThrow(/Stale/)
    expect(spy).not.toHaveBeenCalled()
    expect(evidence.latestCheckpoint(item.workItemId)).toEqual(checkpoint)
    expect(evidence.latestDecision(item.workItemId)).toBeNull()
  })

  it('fails closed when the current host capture fails', async () => {
    const state = await setup()
    prove(state)
    const { f, core, item, evidence } = state
    vi.spyOn(capture, 'captureWorkspaceCheckpoint').mockRejectedValueOnce(
      new Error('Unreadable workspace')
    )
    await expect(core.start(item.workItemId, item.revision)).rejects.toThrow(/Unreadable/)
    expect(core.item(item.workItemId)).toEqual(item)
    expect(evidence.latestDecision(item.workItemId)).toBeNull()
    expect(attempts(f)).toHaveLength(1)
  })

  it.each([
    ['capture', 'revision'],
    ['capture', 'source'],
    ['reservation', 'revision'],
    ['reservation', 'source']
  ])('rechecks %s boundary for changed %s', async (boundary, change) => {
    const state = await setup()
    prove(state)
    const { f, core, item, work } = state
    const mutate = () => {
      if (change === 'revision') {
        work.save({ ...work.item(item.workItemId), artifactRefs: ['changed'] })
      } else {
        f.db.db
          .prepare('UPDATE control_work_items SET execution_id=? WHERE id=?')
          .run('foreign', item.workItemId)
      }
    }
    if (boundary === 'capture') {
      const original = capture.captureWorkspaceCheckpoint
      vi.spyOn(capture, 'captureWorkspaceCheckpoint').mockImplementationOnce(async (path) => {
        const checkpoint = await original(path)
        mutate()
        return checkpoint
      })
    } else {
      const original = ControlEvidenceStore.prototype.checkpoint
      vi.spyOn(ControlEvidenceStore.prototype, 'checkpoint').mockImplementationOnce(
        function (this: ControlEvidenceStore, id, checkpoint) {
          const observed = original.call(this, id, checkpoint)
          queueMicrotask(mutate)
          return observed
        }
      )
    }
    await expect(core.start(item.workItemId, item.revision)).rejects.toThrow(
      /Stale|source identity/
    )
    expect(attempts(f)).toHaveLength(1)
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })

  it.each(['FAILED', 'OUTCOME_UNKNOWN'] as const)(
    'allows only one concurrent %s replacement across separate Core instances',
    async (status) => {
      const state = await setup(status)
      prove(state)
      const { f, core, item } = state
      const other = new ControlCoreFacade(
        f.db,
        checkpointRuntime(f.db, f.runtime),
        f.environment,
        f.verifier
      )
      const results = await Promise.allSettled([
        core.start(item.workItemId, item.revision),
        other.start(item.workItemId, item.revision)
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: expect.objectContaining({ message: 'Stale WorkItem revision' })
      })
      expect(attempts(f)).toHaveLength(2)
      expect(f.runtime.start).toHaveBeenCalledTimes(2)
    }
  )

  it('rolls back native release when replacement reservation fails', async () => {
    const state = await setup('OUTCOME_UNKNOWN')
    prove(state)
    const { f, core, item } = state
    f.db.db
      .exec(`CREATE TRIGGER reject_replacement_handoff BEFORE INSERT ON control_handoff_artifacts
      BEGIN SELECT RAISE(ABORT,'fixture handoff reservation failure'); END`)
    await expect(core.start(item.workItemId, item.revision)).rejects.toThrow(
      /handoff reservation failure/
    )
    expect(core.item(item.workItemId)).toEqual(item)
    expect(
      f.db.db
        .prepare('SELECT recovery_decision_id FROM codex_runtime_executions WHERE execution_id=?')
        .get(item.executionId!)?.recovery_decision_id
    ).toBeNull()
    expect(attempts(f)).toHaveLength(1)
  })

  it('rejects post-admission drift at native capture and retains the old source on subsequent retries', async () => {
    const state = await setup()
    prove(state)
    const { f, core, item, workspace, evidence } = state
    const raced = new ControlCoreFacade(
      f.db,
      checkpointRuntime(f.db, f.runtime),
      () => {
        writeFileSync(join(workspace, 'changed.txt'), 'post-admission drift')
        return f.environment
      },
      f.verifier
    )
    const refused = await raced.start(item.workItemId, item.revision)
    expect(evidence.latestDecision(item.workItemId)?.status).toBe('ELIGIBLE')
    expect(refused).toMatchObject({
      status: 'FAILED',
      executionId: item.executionId,
      nativeTaskId: item.nativeTaskId
    })
    expect(attempts(f)).toHaveLength(2)
    expect(attempts(f)[1].execution_id).toBeNull()
    expect(f.db.getTask(attempts(f)[1].task_id as string)?.status).toBe('failed')
    await expect(core.start(item.workItemId, refused.revision)).rejects.toThrow(/STALE_CHECKPOINT/)
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
    expect(attempts(f)).toHaveLength(2)
  })
})
