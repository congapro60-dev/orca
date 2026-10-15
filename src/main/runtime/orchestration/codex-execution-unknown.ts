import { redactString } from '../../observability/redactor'
import type { OrchestrationDb } from './db'

export function markCodexExecutionUnknown(
  native: OrchestrationDb,
  taskId: string,
  dispatchId: string,
  error: string
): void {
  native.db
    .prepare("UPDATE tasks SET status = 'blocked' WHERE id = ? AND status = 'dispatched'")
    .run(taskId)
  native.db
    .prepare(
      `UPDATE worker_dispatches SET stage = 'programmatic_unverifiable', last_error = ? WHERE dispatch_id = ?`
    )
    .run(redactString(error).slice(0, 2000), dispatchId)
  native.db
    .prepare(
      `UPDATE dispatch_contexts SET capability_revoked_at = COALESCE(capability_revoked_at, datetime('now')) WHERE id = ?`
    )
    .run(dispatchId)
}
