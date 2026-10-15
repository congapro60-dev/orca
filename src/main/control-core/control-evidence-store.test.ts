import { afterEach, describe, expect, it } from 'vitest'
import { coreFixture } from './control-core-test-fixture'
import { ControlWorkStore } from './control-work-store'
import { ControlEvidenceStore } from './control-evidence-store'
import { captureWorkspaceCheckpoint } from './workspace-checkpoint'
import { readLatestHandoff } from './handoff-integrity'

const fixtures: ReturnType<typeof coreFixture>[] = []
function fixture() {
  const f = coreFixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.dispose()
  }
})

describe('Append-only host evidence', () => {
  it('preserves hashed resume decisions across reopen and refuses tampering', () => {
    const f = fixture()
    const { item } = f.create()
    const store = new ControlEvidenceStore(new ControlWorkStore(f.db))
    const decision = store.decision({
      workItemId: item.workItemId,
      sourceExecutionId: null,
      status: 'NEEDS_RECONCILE',
      processVerdict: 'unverifiable',
      baselineCheckpointId: null,
      observedCheckpointId: null,
      reason: 'Unknown token=fixture-decision-secret'
    })
    expect(decision.reason).not.toContain('fixture-decision-secret')
    f.reopen()
    const fresh = new ControlEvidenceStore(new ControlWorkStore(f.db))
    expect(fresh.latestDecision(item.workItemId)).toEqual(decision)
    f.db.db
      .prepare('UPDATE control_resume_decisions SET snapshot=? WHERE id=?')
      .run(JSON.stringify({ ...decision, status: 'ELIGIBLE' }), decision.decisionId)
    expect(() => fresh.latestDecision(item.workItemId)).toThrow(/integrity/)
  })

  it('migrates legacy resume rows without backfilling trusted hashes', () => {
    const f = fixture()
    const { item } = f.create()
    f.db.db.exec(`DROP TABLE control_resume_decisions;
      CREATE TABLE control_resume_decisions (id TEXT PRIMARY KEY,item_id TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL)`)
    f.db.db
      .prepare('INSERT INTO control_resume_decisions VALUES (?,?,?,?)')
      .run('historical', item.workItemId, '{"status":"ELIGIBLE"}', 'historical-time')
    f.reopen()
    const store = new ControlEvidenceStore(new ControlWorkStore(f.db))
    expect(() => store.latestDecision(item.workItemId)).toThrow(/historical capture unverifiable/)
    expect(
      f.db.db
        .prepare('SELECT snapshot,content_hash FROM control_resume_decisions WHERE id=?')
        .get('historical')
    ).toEqual({ snapshot: '{"status":"ELIGIBLE"}', content_hash: null })
  })
  it('retains evidence after later records and a fresh database reopen', async () => {
    const f = fixture()
    const { session, item } = f.create()
    const store = new ControlEvidenceStore(new ControlWorkStore(f.db))
    const baseline = store.checkpoint(
      item.workItemId,
      await captureWorkspaceCheckpoint(f.directory)
    )
    const input = {
      logicalWorkSessionId: session.logicalWorkSessionId,
      workItemId: item.workItemId,
      executionId: null,
      baseline,
      observed: baseline,
      runtimeReceipt: null,
      commands: null,
      tests: null,
      result: 'Evidence token=fixture-secret',
      verificationStatus: 'READY_FOR_REVIEW' as const,
      sourceEvidenceRefs: []
    }
    const original = store.append(input)
    expect(original.result).not.toContain('fixture-secret')
    const verified = store.append({
      ...input,
      result: 'Checked',
      verificationStatus: 'VERIFIED',
      sourceEvidenceRefs: [original.evidenceId]
    })
    expect(verified.evidenceId).not.toBe(original.evidenceId)
    f.reopen()
    const fresh = new ControlEvidenceStore(new ControlWorkStore(f.db))
    expect(fresh.get(original.evidenceId)).toEqual(original)
    expect(fresh.get(verified.evidenceId)).toEqual(verified)
    expect(fresh.get(original.evidenceId).verificationStatus).toBe('READY_FOR_REVIEW')
    expect(fresh.latestCheckpoint(item.workItemId)).toEqual(baseline)
  })

  it('rejects altered checkpoint contents on read and evidence append', async () => {
    const f = fixture()
    const { session, item } = f.create()
    const store = new ControlEvidenceStore(new ControlWorkStore(f.db))
    const baseline = store.checkpoint(
      item.workItemId,
      await captureWorkspaceCheckpoint(f.directory)
    )
    const forged = { ...baseline, workspaceHash: 'forged' }
    f.db.db
      .prepare('UPDATE control_workspace_checkpoints SET snapshot=? WHERE id=?')
      .run(JSON.stringify(forged), baseline.checkpointId)
    expect(() => store.latestCheckpoint(item.workItemId)).toThrow(/integrity/)
    expect(() =>
      store.append({
        logicalWorkSessionId: session.logicalWorkSessionId,
        workItemId: item.workItemId,
        executionId: null,
        baseline: forged,
        observed: null,
        runtimeReceipt: null,
        commands: null,
        tests: null,
        result: null,
        verificationStatus: 'UNVERIFIABLE',
        sourceEvidenceRefs: []
      })
    ).toThrow(/integrity/)
  })

  it('adds the hash column without granting trust to historical checkpoints', async () => {
    const f = fixture()
    const { item } = f.create()
    const baseline = await captureWorkspaceCheckpoint(f.directory)
    f.db.db.exec('DROP TABLE control_workspace_checkpoints')
    f.db.db.exec(`CREATE TABLE control_workspace_checkpoints (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL
    )`)
    f.db.db
      .prepare('INSERT INTO control_workspace_checkpoints VALUES (?,?,?,?)')
      .run(baseline.checkpointId, item.workItemId, JSON.stringify(baseline), baseline.capturedAt)
    f.reopen()
    const store = new ControlEvidenceStore(new ControlWorkStore(f.db))
    expect(() => store.latestCheckpoint(item.workItemId)).toThrow(/historical capture unverifiable/)
    const row = f.db.db
      .prepare('SELECT snapshot,content_hash FROM control_workspace_checkpoints WHERE id=?')
      .get(baseline.checkpointId)
    expect(row).toEqual({ snapshot: JSON.stringify(baseline), content_hash: null })
  })

  it('rejects forged checkpoints and foreign logical/attempt linkage', async () => {
    const f = fixture()
    const { session, item } = f.create()
    const store = new ControlEvidenceStore(new ControlWorkStore(f.db))
    const checkpoint = await captureWorkspaceCheckpoint(f.directory)
    const input = {
      logicalWorkSessionId: session.logicalWorkSessionId,
      workItemId: item.workItemId,
      executionId: null,
      baseline: checkpoint,
      observed: null,
      runtimeReceipt: null,
      commands: null,
      tests: null,
      result: null,
      verificationStatus: 'UNVERIFIABLE' as const,
      sourceEvidenceRefs: []
    }
    expect(() => store.append(input)).toThrow(/registered immutable/)
    store.checkpoint(item.workItemId, checkpoint)
    expect(() =>
      store.append({ ...input, baseline: { ...checkpoint, workspaceHash: 'forged' } })
    ).toThrow(/immutable/)
    expect(() => store.append({ ...input, logicalWorkSessionId: 'foreign' })).toThrow(/identity/)
    expect(() => store.append({ ...input, executionId: 'foreign-execution' })).toThrow(/attempt/)
    expect(store.list(item.workItemId)).toEqual([])
  })

  it('detects persisted evidence tampering rather than accepting a stored hash label', () => {
    const f = fixture()
    const { session, item } = f.create()
    const store = new ControlEvidenceStore(new ControlWorkStore(f.db))
    const record = store.append({
      logicalWorkSessionId: session.logicalWorkSessionId,
      workItemId: item.workItemId,
      executionId: null,
      baseline: null,
      observed: null,
      runtimeReceipt: null,
      commands: null,
      tests: null,
      result: 'Original',
      verificationStatus: 'UNVERIFIABLE',
      sourceEvidenceRefs: []
    })
    f.db.db
      .prepare('UPDATE control_evidence_records SET snapshot=? WHERE id=?')
      .run(JSON.stringify({ ...record, result: 'Changed' }), record.evidenceId)
    expect(() => store.get(record.evidenceId)).toThrow(/integrity/)
  })

  it('binds handoff executions to the WorkItem and detects persisted tampering', () => {
    const f = fixture()
    const { session, item } = f.create()
    const store = new ControlEvidenceStore(new ControlWorkStore(f.db))
    const input = {
      logicalWorkSessionId: session.logicalWorkSessionId,
      workItemId: item.workItemId,
      objective: 'Inspect token=fixture-handoff-secret',
      acceptanceCriteria: ['Return result'],
      worktree: f.directory,
      baselineCommit: null,
      workspaceHash: 'hash',
      changedFiles: [],
      completedWork: [],
      pendingWork: ['Review'],
      constraints: [],
      decisions: [],
      tests: null,
      evidenceRefs: ['https://example.com/evidence?token=fixture-handoff-secret'],
      sourceExecutionId: null,
      targetExecutionId: null
    }
    expect(() => store.handoff({ ...input, sourceExecutionId: 'foreign' })).toThrow(
      /native WorkItem attempt/
    )
    expect(() => store.handoff({ ...input, targetExecutionId: 'foreign' })).toThrow(
      /native WorkItem attempt/
    )
    expect(() => store.handoff({ ...input, worktree: 'foreign-worktree' })).toThrow(/workspace/)
    const record = store.handoff(input)
    expect(JSON.stringify(record)).not.toContain('fixture-handoff-secret')
    expect(readLatestHandoff(store.work, item.workItemId)).toEqual(record)
    f.reopen()
    const fresh = new ControlEvidenceStore(new ControlWorkStore(f.db))
    expect(readLatestHandoff(fresh.work, item.workItemId)).toEqual(record)
    f.db.db
      .prepare('UPDATE control_handoff_artifacts SET snapshot=? WHERE id=?')
      .run(JSON.stringify({ ...record, pendingWork: ['tampered'] }), record.handoffId)
    expect(() => readLatestHandoff(fresh.work, item.workItemId)).toThrow(/integrity/)
  })
})
