import { createHash } from 'node:crypto'
import type { OrchestrationDb } from './db'
import { readProcessObservations } from './codex-process-observation-store'
import type { ResumeDecision, WorkspaceCheckpoint } from '../../../shared/control-evidence-contract'

/** Native acceptance rechecks evidence; an index-release marker is not authority. */
export function assertCodexRecoveryRelease(native: OrchestrationDb, worktree: string): void {
  const unknown = native.db
    .prepare(
      "SELECT execution_id,recovery_decision_id FROM codex_runtime_executions WHERE worktree=? AND status='OUTCOME_UNKNOWN'"
    )
    .all(worktree) as { execution_id: string; recovery_decision_id: string | null }[]
  for (const execution of unknown) {
    const row = native.db
      .prepare('SELECT item_id,snapshot,content_hash FROM control_resume_decisions WHERE id=?')
      .get(execution.recovery_decision_id) as
      | { item_id: string; snapshot: string; content_hash: string | null }
      | undefined
    if (
      !row ||
      createHash('sha256')
        .update(JSON.stringify([row.item_id, row.snapshot]))
        .digest('hex') !== row.content_hash
    ) {
      throw new Error('Unknown Codex execution has no trusted recovery release')
    }
    const decision = JSON.parse(row.snapshot) as ResumeDecision
    const attempt = native.db
      .prepare(`SELECT a.item_id,b.checkpoint_id FROM control_work_attempts a
        JOIN dispatch_contexts d ON d.task_id=a.task_id
        JOIN codex_runtime_executions e ON e.dispatch_id=d.id AND e.execution_id=a.execution_id
        JOIN control_attempt_checkpoints b ON b.execution_id=a.execution_id AND b.item_id=a.item_id
        WHERE a.execution_id=?`)
      .get(execution.execution_id) as { item_id: string; checkpoint_id: string } | undefined
    const proof = readProcessObservations(native, execution.execution_id).at(-1)
    if (
      decision.decisionId !== execution.recovery_decision_id ||
      decision.workItemId !== row.item_id ||
      attempt?.item_id !== row.item_id ||
      attempt.checkpoint_id !== decision.baselineCheckpointId ||
      decision.sourceExecutionId !== execution.execution_id ||
      decision.status !== 'ELIGIBLE' ||
      decision.processVerdict !== 'exited' ||
      proof?.scope !== 'owned-process-launcher' ||
      proof.verdict !== 'exited' ||
      proof.treeVerdict !== 'exited' ||
      !proof.ownedTree
    ) {
      throw new Error('Unknown Codex execution recovery proof mismatch')
    }
    const checkpoints = [decision.baselineCheckpointId, decision.observedCheckpointId].map((id) => {
      const checkpoint = native.db
        .prepare(
          'SELECT snapshot,content_hash FROM control_workspace_checkpoints WHERE id=? AND item_id=?'
        )
        .get(id, row.item_id) as { snapshot: string; content_hash: string | null } | undefined
      if (
        !checkpoint ||
        createHash('sha256')
          .update(JSON.stringify([row.item_id, checkpoint.snapshot]))
          .digest('hex') !== checkpoint.content_hash
      ) {
        throw new Error('Codex recovery checkpoint integrity mismatch')
      }
      const value = JSON.parse(checkpoint.snapshot) as WorkspaceCheckpoint
      if (value.checkpointId !== id || value.worktree !== worktree) {
        throw new Error('Codex recovery checkpoint identity mismatch')
      }
      return value
    })
    if (checkpoints[0].workspaceHash !== checkpoints[1].workspaceHash) {
      throw new Error('Codex recovery checkpoint drift mismatch')
    }
  }
}
