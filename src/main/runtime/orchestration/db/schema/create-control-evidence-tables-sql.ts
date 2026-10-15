export function createControlEvidenceTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS control_workspace_checkpoints (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES control_work_items(id),
  snapshot TEXT NOT NULL, content_hash TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_checkpoint_item ON control_workspace_checkpoints(item_id);
CREATE TABLE IF NOT EXISTS control_attempt_checkpoints (
  execution_id TEXT PRIMARY KEY REFERENCES codex_runtime_executions(execution_id),
  checkpoint_id TEXT NOT NULL REFERENCES control_workspace_checkpoints(id),
  item_id TEXT NOT NULL REFERENCES control_work_items(id)
);
CREATE TABLE IF NOT EXISTS control_evidence_records (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES control_work_sessions(id),
  item_id TEXT NOT NULL REFERENCES control_work_items(id), execution_id TEXT,
  snapshot TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_evidence_item ON control_evidence_records(item_id);
CREATE TABLE IF NOT EXISTS control_resume_decisions (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES control_work_items(id),
  snapshot TEXT NOT NULL, content_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_handoff_artifacts (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES control_work_items(id),
  snapshot TEXT NOT NULL, content_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS codex_runtime_command_evidence (
  execution_id TEXT PRIMARY KEY REFERENCES codex_runtime_executions(execution_id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS codex_runtime_process_observations (
  execution_id TEXT PRIMARY KEY REFERENCES codex_runtime_executions(execution_id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL, content_hash TEXT
);
`
}
