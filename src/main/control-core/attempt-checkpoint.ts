import type { WorkspaceCheckpoint } from '../../shared/control-evidence-contract'
import type { ControlWorkStore } from './control-work-store'
import { ControlEvidenceStore } from './control-evidence-store'

export function bindAttemptCheckpoint(
  work: ControlWorkStore,
  itemId: string,
  executionId: string,
  checkpoint: WorkspaceCheckpoint
): void {
  const attempt = work.native.db
    .prepare(`SELECT a.item_id FROM control_work_attempts a
      JOIN dispatch_contexts d ON d.task_id=a.task_id
      JOIN codex_runtime_executions e ON e.dispatch_id=d.id
      WHERE e.execution_id=? AND (a.execution_id IS NULL OR a.execution_id=e.execution_id)`)
    .get(executionId) as { item_id: string } | undefined
  if (attempt?.item_id !== itemId) {
    throw new Error('Checkpoint source execution does not belong to WorkItem attempt')
  }
  new ControlEvidenceStore(work).registeredCheckpoint(itemId, checkpoint)
  work.native.db
    .prepare(
      'INSERT INTO control_attempt_checkpoints (execution_id,checkpoint_id,item_id) VALUES (?,?,?)'
    )
    .run(executionId, checkpoint.checkpointId, itemId)
}

export function attemptCheckpoint(
  work: ControlWorkStore,
  itemId: string,
  executionId: string
): WorkspaceCheckpoint | null {
  const row = work.native.db
    .prepare(`SELECT c.snapshot FROM control_attempt_checkpoints b
    JOIN control_workspace_checkpoints c ON c.id=b.checkpoint_id
    JOIN control_work_attempts a ON a.execution_id=b.execution_id
    WHERE b.execution_id=? AND b.item_id=? AND a.item_id=b.item_id AND c.item_id=b.item_id`)
    .get(executionId, itemId) as { snapshot: string } | undefined
  return row
    ? new ControlEvidenceStore(work).registeredCheckpoint(
        itemId,
        JSON.parse(row.snapshot) as WorkspaceCheckpoint
      )
    : null
}
