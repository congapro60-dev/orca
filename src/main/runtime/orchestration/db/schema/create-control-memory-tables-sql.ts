export function createControlMemoryTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS control_task_journals (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES control_work_sessions(id),
  project_id TEXT NOT NULL, snapshot TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_memory_candidates (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES control_work_sessions(id),
  journal_id TEXT NOT NULL REFERENCES control_task_journals(id),
  statement TEXT NOT NULL, kind TEXT NOT NULL, evidence_refs TEXT NOT NULL, artifact_refs TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('CANDIDATE','REJECTED','PROMOTED','SUPERSEDED')),
  revision INTEGER NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_memory_project ON control_memory_candidates(project_id);
CREATE TABLE IF NOT EXISTS control_canonical_memory (
  project_id TEXT NOT NULL, memory_key TEXT NOT NULL, snapshot TEXT NOT NULL,
  PRIMARY KEY(project_id,memory_key)
);
CREATE TABLE IF NOT EXISTS control_memory_promotions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, memory_key TEXT NOT NULL,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES control_memory_candidates(id),
  previous_snapshot TEXT, promoted_snapshot TEXT NOT NULL, created_at TEXT NOT NULL
);
`
}
