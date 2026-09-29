export function createCodexExecutionTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS codex_runtime_executions (
  execution_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL UNIQUE REFERENCES dispatch_contexts(id) ON DELETE CASCADE,
  worktree TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'STARTING'
    CHECK(status IN ('STARTING','RUNNING','COMPLETED','FAILED','CANCELLED','OUTCOME_UNKNOWN')),
  receipt_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS codex_runtime_events (
  execution_id TEXT NOT NULL REFERENCES codex_runtime_executions(execution_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY(execution_id, sequence)
);
CREATE TABLE IF NOT EXISTS codex_runtime_results (
  execution_id TEXT PRIMARY KEY REFERENCES codex_runtime_executions(execution_id) ON DELETE CASCADE,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_active_worktree
  ON codex_runtime_executions(worktree)
  WHERE status IN ('STARTING','RUNNING','OUTCOME_UNKNOWN');
`
}
