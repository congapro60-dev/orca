import type { WorkItem } from '../../shared/control-core-contract'
import type { WorkspaceCheckpoint } from '../../shared/control-evidence-contract'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { ControlWorkStore } from './control-work-store'
import { ControlEvidenceStore } from './control-evidence-store'

export function hasReadOnlyCheckpointEvidence(native: OrchestrationDb, item: WorkItem): boolean {
  const record = new ControlEvidenceStore(new ControlWorkStore(native))
    .list(item.workItemId)
    .find((entry) => entry.executionId === item.executionId)
  return (
    !!record &&
    record.verificationStatus === 'READY_FOR_REVIEW' &&
    !!record.baseline &&
    !!record.observed &&
    record.baseline.workspaceHash === record.observed.workspaceHash &&
    record.runtimeReceipt?.executionId === item.executionId
  )
}

/** Append the host decision in the same transaction as canonical verification; retain the old row. */
export function recordVerificationEvidence(
  work: ControlWorkStore,
  item: WorkItem,
  passed: boolean,
  refs: string[]
): string | null {
  const store = new ControlEvidenceStore(work)
  const original = store
    .list(item.workItemId)
    .find((entry) => entry.executionId === item.executionId)
  if (!original) {
    // Legacy evidence was not captured; do not fabricate a historical snapshot.
    return null
  }
  const checkpoint = (id: string | undefined) => {
    if (!id) {
      return null
    }
    const row = work.native.db
      .prepare('SELECT snapshot FROM control_workspace_checkpoints WHERE id=? AND item_id=?')
      .get(id, item.workItemId) as { snapshot: string } | undefined
    if (!row) {
      throw new Error('Verification evidence checkpoint is unavailable')
    }
    return store.registeredCheckpoint(
      item.workItemId,
      JSON.parse(row.snapshot) as WorkspaceCheckpoint
    )
  }
  const { evidenceId: _id, contentHash: _hash, createdAt: _at, ...captured } = original
  return store.append({
    ...captured,
    baseline: checkpoint(original.baseline?.checkpointId),
    observed: checkpoint(original.observed?.checkpointId),
    verificationStatus: passed ? 'VERIFIED' : 'REJECTED',
    sourceEvidenceRefs: [...new Set([`evidence:${original.evidenceId}`, ...refs])]
  }).evidenceId
}
