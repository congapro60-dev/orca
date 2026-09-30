import type { OrchestrationDb } from '../orchestration-db'
import { createCoreTablesSql } from './create-core-tables-sql'
import { createGraphTablesSql } from './create-graph-tables-sql'
import { createCodexExecutionTablesSql } from './create-codex-execution-tables-sql'
import { createControlCoreTablesSql } from './create-control-core-tables-sql'
import { createControlMemoryTablesSql } from './create-control-memory-tables-sql'

export function createTables(this: OrchestrationDb): void {
  this.db.exec(`${createCoreTablesSql()}\n${createGraphTablesSql()}`)
  this.db.exec(createCodexExecutionTablesSql())
  this.db.exec(createControlCoreTablesSql())
  this.db.exec(createControlMemoryTablesSql())
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
