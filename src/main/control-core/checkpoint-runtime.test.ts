import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { coreFixture } from './control-core-test-fixture'
import { ControlCoreFacade } from './control-core-facade'
import { checkpointRuntime } from './checkpoint-runtime'
import { CodexExecutionStore } from '../runtime/orchestration/codex-execution-store'
import { ControlWorkStore } from './control-work-store'
import { attemptCheckpoint } from './attempt-checkpoint'
import { ControlEvidenceStore } from './control-evidence-store'
import type { CodexRuntimeReceipt } from '../../shared/codex-runtime-contract'

const fixtures: ReturnType<typeof coreFixture>[] = []
afterEach(() => fixtures.splice(0).forEach((f) => f.dispose()))

describe('Native automatic attempt checkpoints', () => {
  it('captures terminal evidence on Core wait and retains it after reopen without duplicating it', async () => {
    const f = coreFixture()
    fixtures.push(f)
    const { item } = f.create()
    const nativeRuntime = new CodexExecutionStore(f.db, 'fixture-epoch')
    f.runtime.start.mockImplementation(async (taskId, request) =>
      nativeRuntime.accept(taskId, randomUUID(), request.worktree)
    )
    f.runtime.result.mockImplementation(async (id) => {
      const record = nativeRuntime.require(id)
      const receipt: CodexRuntimeReceipt = {
        executionId: id,
        requestedRuntime: 'codex',
        resolvedExecutablePath: f.environment.executablePath,
        resolvedExecutableVersion: 'fixture',
        runtimeProtocol: 'codex-app-server-jsonrpc-v2',
        requestedModel: null,
        resolvedModel: null,
        actualModel: 'UNKNOWN_UNVERIFIED',
        effectiveSandbox: 'READ_ONLY',
        approvalPolicy: 'never',
        worktree: record.worktree,
        codexHome: f.environment.codexHome,
        threadId: 'fixture-thread',
        turnId: 'fixture-turn'
      }
      if (record.status === 'STARTING') {
        nativeRuntime.save({ receipt, status: 'RUNNING', text: '', error: null })
        nativeRuntime.save({
          receipt,
          status: 'COMPLETED',
          text: 'Native result token=fixture-secret',
          error: null,
          commands: [{ itemId: 'cmd', command: 'test', exitCode: 2, status: 'completed' }]
        })
      }
      return nativeRuntime.require(id)
    })
    const port = checkpointRuntime(f.db, f.runtime)
    const core = new ControlCoreFacade(f.db, port, f.environment, f.verifier)
    const started = await core.start(item.workItemId, item.revision)
    await vi.waitFor(() =>
      expect(f.db.db.prepare('SELECT count(*) AS n FROM control_evidence_records').get()?.n).toBe(1)
    )
    await Promise.all([port.result(started.executionId!), port.result(started.executionId!)])
    const evidence = new ControlEvidenceStore(new ControlWorkStore(f.db)).list(item.workItemId)
    expect(evidence).toHaveLength(1)
    expect(evidence[0].commands?.[0].exitCode).toBe(2)
    expect(evidence[0].result).not.toContain('fixture-secret')
    expect(evidence[0].observed?.checkpointId).not.toBe(evidence[0].baseline?.checkpointId)
    expect(evidence[0].verificationStatus).toBe('READY_FOR_REVIEW')
    const ready = await core.wait(item.workItemId)
    f.db.db
      .exec(`CREATE TRIGGER reject_verification_evidence BEFORE INSERT ON control_evidence_records
      WHEN json_extract(NEW.snapshot,'$.verificationStatus')='VERIFIED'
      BEGIN SELECT RAISE(ABORT,'verification evidence failure'); END`)
    await expect(core.verify(item.workItemId, ready.revision)).rejects.toThrow(
      /verification evidence failure/
    )
    expect(core.item(item.workItemId).status).toBe('READY_FOR_REVIEW')
    f.db.db.exec('DROP TRIGGER reject_verification_evidence')
    await core.verify(item.workItemId, ready.revision)
    const verified = new ControlEvidenceStore(new ControlWorkStore(f.db))
      .list(item.workItemId)
      .find((record) => record.verificationStatus === 'VERIFIED')!
    expect(verified.sourceEvidenceRefs).toContain(`evidence:${evidence[0].evidenceId}`)
    expect(core.item(item.workItemId).evidenceRefs).toContain(`evidence:${verified.evidenceId}`)
    f.reopen()
    expect(
      new ControlEvidenceStore(new ControlWorkStore(f.db)).get(evidence[0].evidenceId)
    ).toEqual(evidence[0])
    expect(new ControlEvidenceStore(new ControlWorkStore(f.db)).get(verified.evidenceId)).toEqual(
      verified
    )
  })
  it('captures before native dispatch, binds the returned execution and survives reopen', async () => {
    const f = coreFixture()
    fixtures.push(f)
    const { item } = f.create()
    f.runtime.start.mockImplementation(async (taskId, request) => {
      expect(
        f.db.db.prepare('SELECT count(*) AS n FROM control_workspace_checkpoints').get()?.n
      ).toBe(1)
      return new CodexExecutionStore(f.db, 'fixture-epoch').accept(
        taskId,
        randomUUID(),
        request.worktree
      )
    })
    const core = new ControlCoreFacade(
      f.db,
      checkpointRuntime(f.db, f.runtime),
      f.environment,
      f.verifier
    )
    const started = await core.start(item.workItemId, item.revision)
    expect(started.status).toBe('WAITING')
    expect(started.executionId).toBeTruthy()
    const baseline = attemptCheckpoint(
      new ControlWorkStore(f.db),
      item.workItemId,
      started.executionId!
    )
    expect(baseline?.worktree).toBe(f.directory)
    f.reopen()
    expect(
      attemptCheckpoint(new ControlWorkStore(f.db), item.workItemId, started.executionId!)
    ).toEqual(baseline)
  })

  it('retries proven-unstarted preflight failure without requiring execution continuity', async () => {
    const f = coreFixture()
    fixtures.push(f)
    const { item } = f.create()
    f.runtime.start.mockRejectedValueOnce(new Error('preflight refusal'))
    const core = new ControlCoreFacade(
      f.db,
      checkpointRuntime(f.db, f.runtime),
      f.environment,
      f.verifier
    )
    const failed = await core.start(item.workItemId, item.revision)
    expect(failed.status).toBe('FAILED')
    expect(failed.executionId).toBeNull()
    expect(f.db.db.prepare('SELECT count(*) AS n FROM control_attempt_checkpoints').get()?.n).toBe(
      0
    )
    f.runtime.start.mockImplementation(async (taskId, request) =>
      new CodexExecutionStore(f.db, 'fixture-epoch').accept(taskId, randomUUID(), request.worktree)
    )
    f.runtime.result.mockImplementation(() => new Promise(() => {}))
    const retry = await core.start(item.workItemId, failed.revision)
    expect(retry.status).toBe('WAITING')
    expect(retry.executionId).toBeTruthy()
    expect(f.db.getTask(failed.nativeTaskId!)?.status).toBe('failed')
    expect(f.runtime.start).toHaveBeenCalledTimes(2)
    expect(f.db.db.prepare('SELECT count(*) AS n FROM control_work_attempts').get()?.n).toBe(2)
  })

  it('honors cancellation during capture without dispatching a runtime', async () => {
    const f = coreFixture()
    fixtures.push(f)
    const { item } = f.create()
    const core = new ControlCoreFacade(
      f.db,
      checkpointRuntime(f.db, f.runtime),
      f.environment,
      f.verifier
    )
    const pending = core.start(item.workItemId, item.revision)
    await core.cancel(item.workItemId)
    const cancelled = await pending
    expect(cancelled.status).toBe('CANCELLED')
    expect(f.runtime.start).not.toHaveBeenCalled()
    expect(f.db.db.prepare('SELECT count(*) AS n FROM control_attempt_checkpoints').get()?.n).toBe(
      0
    )
    f.runtime.start.mockImplementation(async (taskId, request) =>
      new CodexExecutionStore(f.db, 'fixture-epoch').accept(taskId, randomUUID(), request.worktree)
    )
    f.runtime.result.mockImplementation(() => new Promise(() => {}))
    const retry = await core.start(item.workItemId, cancelled.revision)
    expect(retry.status).toBe('WAITING')
    expect(retry.executionId).toBeTruthy()
    expect(retry.cancelRequested).toBe(false)
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })
})
