import { afterEach, describe, expect, it } from 'vitest'
import { coreFixture } from './control-core-test-fixture'
import { ControlEvidenceStore } from './control-evidence-store'
import { captureWorkspaceCheckpoint } from './workspace-checkpoint'
import { reconcileResume } from './resume-reconcile'
import { ControlWorkStore } from './control-work-store'
import { bindAttemptCheckpoint } from './attempt-checkpoint'
import { CodexExecutionStore } from '../runtime/orchestration/codex-execution-store'
import { writeProcessObservations } from '../runtime/orchestration/codex-process-observation-store'
import { randomUUID } from 'node:crypto'

const fixtures: ReturnType<typeof coreFixture>[] = []
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()))

describe('Host-owned resume admission', () => {
  it('uses the attempt-bound baseline even after observed checkpoints are appended', async () => {
    const f = coreFixture()
    fixtures.push(f)
    const { item, session } = f.create()
    const work = new ControlWorkStore(f.db)
    const evidence = new ControlEvidenceStore(work)
    const baseline = evidence.checkpoint(
      item.workItemId,
      await captureWorkspaceCheckpoint(f.directory)
    )
    const task = f.db.createTask({ spec: 'Inspect', runId: session.runId })
    const executionId = randomUUID()
    new CodexExecutionStore(f.db, 'test-epoch').accept(task.id, executionId, f.directory)
    f.db.db
      .prepare(
        'INSERT INTO control_work_attempts (task_id,item_id,execution_id,created_at) VALUES (?,?,?,?)'
      )
      .run(task.id, item.workItemId, executionId, new Date().toISOString())
    work.save({ ...work.item(item.workItemId), nativeTaskId: task.id, executionId })
    bindAttemptCheckpoint(work, item.workItemId, executionId, baseline)
    writeProcessObservations(f.db, executionId, [
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
    const observed = evidence.checkpoint(item.workItemId, {
      ...baseline,
      checkpointId: randomUUID(),
      workspaceHash: 'different'
    })
    const decision = f.core.reconcileResume({
      workItemId: item.workItemId,
      sourceExecutionId: executionId,
      observed
    })
    expect(decision.status).toBe('STALE_CHECKPOINT')
    expect(decision.baselineCheckpointId).toBe(baseline.checkpointId)
    const same = evidence.checkpoint(item.workItemId, { ...baseline, checkpointId: randomUUID() })
    expect(
      f.core.reconcileResume({
        workItemId: item.workItemId,
        sourceExecutionId: executionId,
        observed: same
      }).status
    ).toBe('ELIGIBLE')
    expect(f.runtime.start).not.toHaveBeenCalled()
    expect(() => bindAttemptCheckpoint(work, item.workItemId, executionId, observed)).toThrow()
    expect(
      f.reopen().reconcileResume({
        workItemId: item.workItemId,
        sourceExecutionId: executionId,
        observed: same
      }).status
    ).toBe('ELIGIBLE')
  })

  it('does not upgrade historical boolean-only tree exit to owned containment proof', async () => {
    const f = coreFixture()
    fixtures.push(f)
    const { item, session } = f.create()
    const work = new ControlWorkStore(f.db)
    const evidence = new ControlEvidenceStore(work)
    const checkpoint = evidence.checkpoint(
      item.workItemId,
      await captureWorkspaceCheckpoint(f.directory)
    )
    const task = f.db.createTask({ spec: 'Inspect', runId: session.runId })
    const id = randomUUID()
    new CodexExecutionStore(f.db, 'legacy').accept(task.id, id, f.directory)
    f.db.db
      .prepare(
        'INSERT INTO control_work_attempts (task_id,item_id,execution_id,created_at) VALUES (?,?,?,?)'
      )
      .run(task.id, item.workItemId, id, new Date().toISOString())
    work.save({ ...item, nativeTaskId: task.id, executionId: id })
    bindAttemptCheckpoint(work, item.workItemId, id, checkpoint)
    writeProcessObservations(f.db, id, [
      {
        incarnationId: randomUUID(),
        pid: 77,
        scope: 'app-server-child',
        verdict: 'exited',
        treeVerdict: 'exited',
        observedAt: new Date().toISOString(),
        exitCode: 0,
        signal: null
      }
    ])
    const decision = f.core.reconcileResume({
      workItemId: item.workItemId,
      sourceExecutionId: id,
      observed: checkpoint
    })
    expect(decision.status).toBe('NEEDS_RECONCILE')
    expect(decision.processVerdict).toBe('unverifiable')
  })
  it('refuses no-drift when source execution is foreign, preserving WorkItem identity', async () => {
    const fixture = coreFixture()
    fixtures.push(fixture)
    const { item } = fixture.create()
    const store = new ControlEvidenceStore(new ControlWorkStore(fixture.db))
    const checkpoint = store.checkpoint(
      item.workItemId,
      await captureWorkspaceCheckpoint(fixture.directory)
    )
    const decision = reconcileResume(store.work, {
      workItemId: item.workItemId,
      sourceExecutionId: 'exec-old',
      observed: checkpoint
    })
    expect(decision.status).toBe('NEEDS_RECONCILE')
    expect(decision.workItemId).toBe(item.workItemId)
    expect(fixture.core.item(item.workItemId).workItemId).toBe(item.workItemId)
  })

  it('rejects a foreign baseline binding', async () => {
    const fixture = coreFixture()
    fixtures.push(fixture)
    const { item } = fixture.create()
    const work = new ControlWorkStore(fixture.db)
    const checkpoint = new ControlEvidenceStore(work).checkpoint(
      item.workItemId,
      await captureWorkspaceCheckpoint(fixture.directory)
    )
    expect(() => bindAttemptCheckpoint(work, item.workItemId, 'foreign', checkpoint)).toThrow(
      /attempt/
    )
  })

  it('ignores caller-supplied exit claims for an unowned execution', async () => {
    const fixture = coreFixture()
    fixtures.push(fixture)
    const { item } = fixture.create()
    const decision = reconcileResume(new ControlWorkStore(fixture.db), {
      workItemId: item.workItemId,
      sourceExecutionId: 'exec-old',
      observed: null,
      processVerdict: 'exited'
    } as never)
    expect(decision.status).toBe('NEEDS_RECONCILE')
  })

  it('classifies a native failed source as INTERRUPTED without authorizing replacement', () => {
    const fixture = coreFixture()
    fixtures.push(fixture)
    const { item, session } = fixture.create()
    const task = fixture.db.createTask({ spec: 'Inspect', runId: session.runId })
    const executionId = '00000000-0000-4000-8000-000000000001'
    new CodexExecutionStore(fixture.db, 'old').accept(task.id, executionId, fixture.directory)
    fixture.db.db
      .prepare(
        'INSERT INTO control_work_attempts (task_id,item_id,execution_id,created_at) VALUES (?,?,?,?)'
      )
      .run(task.id, item.workItemId, executionId, new Date().toISOString())
    fixture.db.db
      .prepare("UPDATE codex_runtime_executions SET status='FAILED' WHERE execution_id=?")
      .run(executionId)
    const work = new ControlWorkStore(fixture.db)
    work.save({ ...work.item(item.workItemId), nativeTaskId: task.id, executionId })
    const decision = reconcileResume(new ControlWorkStore(fixture.db), {
      workItemId: item.workItemId,
      sourceExecutionId: executionId,
      observed: null
    })
    expect(decision.status).toBe('INTERRUPTED')
    expect(decision.processVerdict).toBe('unverifiable')
  })

  it('keeps unowned execution unverifiable even with separately registered drifted snapshots', async () => {
    const fixture = coreFixture()
    fixtures.push(fixture)
    const { item } = fixture.create()
    const store = new ControlEvidenceStore(new ControlWorkStore(fixture.db))
    const captured = await captureWorkspaceCheckpoint(fixture.directory)
    const observed = store.checkpoint(item.workItemId, {
      ...captured,
      checkpointId: 'observed',
      workspaceHash: 'drifted'
    })
    store.checkpoint(item.workItemId, captured)
    const decision = reconcileResume(store.work, {
      workItemId: item.workItemId,
      sourceExecutionId: 'exec-old',
      observed
    })
    expect(decision.status).toBe('NEEDS_RECONCILE')
  })
})
