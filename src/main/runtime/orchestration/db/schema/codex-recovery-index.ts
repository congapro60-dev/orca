import type { OrchestrationDb } from '../orchestration-db'

export function addCodexRecoveryIndex(native: OrchestrationDb): void {
  const columns = native.db.prepare('PRAGMA table_info(codex_runtime_executions)').all() as {
    name: string
  }[]
  if (columns.some((column) => column.name === 'recovery_decision_id')) {
    return
  }
  native.db.exec('SAVEPOINT codex_recovery_index')
  try {
    native.db.exec(`
      ALTER TABLE codex_runtime_executions ADD COLUMN recovery_decision_id TEXT REFERENCES control_resume_decisions(id);
      DROP INDEX idx_codex_active_worktree;
      CREATE UNIQUE INDEX idx_codex_active_worktree ON codex_runtime_executions(worktree)
        WHERE status IN ('STARTING','RUNNING') OR (status='OUTCOME_UNKNOWN' AND recovery_decision_id IS NULL);
    `)
    native.db.exec('RELEASE codex_recovery_index')
  } catch (error) {
    native.db.exec('ROLLBACK TO codex_recovery_index; RELEASE codex_recovery_index')
    throw error
  }
}
