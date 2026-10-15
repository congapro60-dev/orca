import type { WorkItem, WorkContextCapsule } from '../../shared/control-core-contract'
import type { WorkspaceCheckpoint, HandoffArtifactV0 } from '../../shared/control-evidence-contract'
import type { ControlWorkStore } from './control-work-store'
import { ControlEvidenceStore } from './control-evidence-store'
import { readHandoff } from './handoff-integrity'

export function prepareResumeHandoff(
  work: ControlWorkStore,
  item: WorkItem,
  checkpoint: WorkspaceCheckpoint
) {
  const store = new ControlEvidenceStore(work)
  const evidence = store.list(item.workItemId).filter((row) => row.executionId === item.executionId)
  const decisions = work.native.db
    .prepare(
      "SELECT payload FROM control_work_events WHERE session_id=? AND type='DECISION_RECORDED' ORDER BY sequence DESC LIMIT 8"
    )
    .all(item.logicalWorkSessionId) as { payload: string }[]
  return store.handoff({
    logicalWorkSessionId: item.logicalWorkSessionId,
    workItemId: item.workItemId,
    objective: item.objective,
    acceptanceCriteria: item.doneWhen,
    worktree: checkpoint.worktree,
    baselineCommit: checkpoint.baselineCommit,
    workspaceHash: checkpoint.workspaceHash,
    changedFiles: checkpoint.changedFiles,
    completedWork: evidence
      .filter((row) => row.verificationStatus === 'VERIFIED')
      .map((row) => `Verified evidence: ${row.evidenceId}`)
      .slice(0, 64),
    pendingWork: [item.objective],
    constraints: item.constraints,
    decisions: decisions.toReversed().map((row) => String(JSON.parse(row.payload).decision)),
    tests: evidence[0]?.tests ?? null,
    evidenceRefs: [
      ...new Set([...item.evidenceRefs, ...evidence.map((row) => `evidence:${row.evidenceId}`)])
    ].slice(0, 64),
    sourceExecutionId: item.executionId,
    targetExecutionId: null
  })
}

export function handoffCapsule(handoff: HandoffArtifactV0): WorkContextCapsule {
  return {
    id: `handoff:${handoff.handoffId}`,
    content: JSON.stringify({
      handoffId: handoff.handoffId,
      sourceExecutionId: handoff.sourceExecutionId,
      baselineCommit: handoff.baselineCommit,
      workspaceHash: handoff.workspaceHash,
      evidenceRefs: handoff.evidenceRefs.slice(0, 3),
      decisions: handoff.decisions.slice(-3).map((decision) => decision.slice(0, 1000)),
      contextIsPartial: true,
      priorResultIsNotVerification: true
    })
  }
}

/** Assignment binds the pending artifact to a reserved task, including receipt-loss recovery. */
export function completeResumeHandoff(work: ControlWorkStore, item: WorkItem): void {
  const assignment = work.native.db
    .prepare(
      "SELECT payload FROM control_work_events WHERE item_id=? AND type='WORK_ASSIGNED' AND json_extract(payload,'$.nativeTaskId')=? ORDER BY sequence DESC LIMIT 1"
    )
    .get(item.workItemId, item.nativeTaskId) as { payload: string } | undefined
  const handoffId = assignment ? JSON.parse(assignment.payload).handoffId : undefined
  if (!handoffId || !item.executionId) {
    return
  }
  const pending = readHandoff(work, item.workItemId, handoffId)
  if (
    !pending.sourceExecutionId ||
    pending.targetExecutionId ||
    pending.sourceExecutionId === item.executionId
  ) {
    throw new Error('Resume handoff assignment has an invalid execution lineage')
  }
  const existing = work.native.db
    .prepare(
      "SELECT id FROM control_handoff_artifacts WHERE item_id=? AND json_extract(snapshot,'$.targetExecutionId')=? LIMIT 1"
    )
    .get(item.workItemId, item.executionId) as { id: string } | undefined
  if (existing) {
    if (
      readHandoff(work, item.workItemId, existing.id).sourceExecutionId !==
      pending.sourceExecutionId
    ) {
      throw new Error('Resume handoff target lineage mismatch')
    }
    return
  }
  const complete = new ControlEvidenceStore(work).handoff({
    ...pending,
    targetExecutionId: item.executionId
  })
  work.event(item, 'ARTIFACT_PUBLISHED', {
    artifactRef: `handoff:${complete.handoffId}`,
    sourceHandoffId: pending.handoffId
  })
}
