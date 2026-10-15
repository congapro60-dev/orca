import type { OrchestrationDb } from '../orchestration-db'
import { createCoreTablesSql } from './create-core-tables-sql'
import { createGraphTablesSql } from './create-graph-tables-sql'
import { createCodexExecutionTablesSql } from './create-codex-execution-tables-sql'
import { createControlCoreTablesSql } from './create-control-core-tables-sql'
import { createControlMemoryTablesSql } from './create-control-memory-tables-sql'
import { createControlEvidenceTablesSql } from './create-control-evidence-tables-sql'
import { addCodexRecoveryIndex } from './codex-recovery-index'

export function createTables(this: OrchestrationDb): void {
  this.db.exec(`${createCoreTablesSql()}\n${createGraphTablesSql()}`)
  this.db.exec(createCodexExecutionTablesSql())
  this.db.exec(createControlCoreTablesSql())
  this.db.exec(createControlMemoryTablesSql())
  this.db.exec(createControlEvidenceTablesSql())
  addCodexRecoveryIndex(this)
  const checkpointColumns = this.db
    .prepare('PRAGMA table_info(control_workspace_checkpoints)')
    .all() as {
    name: string
  }[]
  if (!checkpointColumns.some((column) => column.name === 'content_hash')) {
    // Historical snapshots stay unverifiable; never backfill trust from their current contents.
    this.db.exec('ALTER TABLE control_workspace_checkpoints ADD COLUMN content_hash TEXT')
  }
  const processColumns = this.db
    .prepare('PRAGMA table_info(codex_runtime_process_observations)')
    .all() as {
    name: string
  }[]
  if (!processColumns.some((column) => column.name === 'content_hash')) {
    this.db.exec('ALTER TABLE codex_runtime_process_observations ADD COLUMN content_hash TEXT')
  }
  const handoffColumns = this.db.prepare('PRAGMA table_info(control_handoff_artifacts)').all() as {
    name: string
  }[]
  if (!handoffColumns.some((column) => column.name === 'content_hash')) {
    this.db.exec('ALTER TABLE control_handoff_artifacts ADD COLUMN content_hash TEXT')
  }
  const decisionColumns = this.db.prepare('PRAGMA table_info(control_resume_decisions)').all() as {
    name: string
  }[]
  if (!decisionColumns.some((column) => column.name === 'content_hash')) {
    this.db.exec('ALTER TABLE control_resume_decisions ADD COLUMN content_hash TEXT')
  }
  this.createMailboxDeliveryIndexesIfPossible()
}

export type CreateTablesMethods = {
  createTables: typeof createTables
}

export function attachCreateTables(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createTables
  })
}
