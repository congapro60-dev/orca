import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function assertTerminalDispatch(db: OrchestrationDb, dispatchId: string): void {
  if (
    db.db.prepare('SELECT 1 FROM codex_runtime_executions WHERE dispatch_id = ?').get(dispatchId)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      'Programmatic Codex execution requires codex-cancel or runtime reconciliation; terminal stop/abandon is forbidden.'
    )
  }
}
