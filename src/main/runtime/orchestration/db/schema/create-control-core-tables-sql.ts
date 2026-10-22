export function createControlCoreTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS control_work_sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree TEXT NOT NULL,
  objective TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ACTIVE','COMPLETED','BLOCKED','CANCELLED')),
  root_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_work_session_profiles (
  session_id TEXT PRIMARY KEY REFERENCES control_work_sessions(id),
  permission_mode TEXT NOT NULL CHECK(permission_mode IN ('READ_ONLY','WORKSPACE_WRITE'))
);
CREATE TABLE IF NOT EXISTS control_work_items (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES control_work_sessions(id),
  parent_id TEXT REFERENCES control_work_items(id), branch_id TEXT NOT NULL, objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','WAITING','RUNNING','READY_FOR_REVIEW','VERIFIED','FAILED','BLOCKED','CANCELLED')),
  depends_on TEXT NOT NULL DEFAULT '[]', runtime TEXT, artifacts TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]', done_when TEXT NOT NULL DEFAULT '[]', constraints_json TEXT NOT NULL DEFAULT '[]',
  native_task_id TEXT REFERENCES tasks(id), execution_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_work_session ON control_work_items(session_id);
CREATE TABLE IF NOT EXISTS control_work_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES control_work_sessions(id),
  item_id TEXT NOT NULL REFERENCES control_work_items(id), type TEXT NOT NULL, payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_peer_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES control_work_sessions(id),
  recipient_id TEXT NOT NULL REFERENCES control_work_items(id), envelope TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_peer_recipient ON control_peer_messages(recipient_id);
CREATE TABLE IF NOT EXISTS control_work_attempts (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), item_id TEXT NOT NULL REFERENCES control_work_items(id),
  execution_id TEXT UNIQUE, created_at TEXT NOT NULL
);
`
}
