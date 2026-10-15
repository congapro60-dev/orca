import { createHash } from 'node:crypto'
import type { ControlWorkStore } from './control-work-store'
import type { HandoffArtifactV0 } from '../../shared/control-evidence-contract'

export function handoffContentHash(itemId: string, snapshot: string): string {
  return createHash('sha256')
    .update(JSON.stringify([itemId, snapshot]))
    .digest('hex')
}

export function assertHandoffExecutions(
  work: ControlWorkStore,
  itemId: string,
  ids: (string | null)[]
): void {
  for (const executionId of ids) {
    if (executionId === null) {
      continue
    }
    const attempt = work.native.db
      .prepare(`SELECT a.item_id FROM control_work_attempts a
      JOIN dispatch_contexts d ON d.task_id=a.task_id
      JOIN codex_runtime_executions e ON e.dispatch_id=d.id AND e.execution_id=a.execution_id
      WHERE a.execution_id=?`)
      .get(executionId) as { item_id: string } | undefined
    if (attempt?.item_id !== itemId) {
      throw new Error('Handoff execution does not belong to native WorkItem attempt')
    }
  }
}

export function readLatestHandoff(
  work: ControlWorkStore,
  itemId: string
): HandoffArtifactV0 | null {
  work.item(itemId)
  const row = work.native.db
    .prepare('SELECT id FROM control_handoff_artifacts WHERE item_id=? ORDER BY rowid DESC LIMIT 1')
    .get(itemId) as { id: string } | undefined
  return row ? readHandoff(work, itemId, row.id) : null
}

export function readHandoff(work: ControlWorkStore, itemId: string, id: string): HandoffArtifactV0 {
  const row = work.native.db
    .prepare('SELECT snapshot,content_hash FROM control_handoff_artifacts WHERE item_id=? AND id=?')
    .get(itemId, id) as { snapshot: string; content_hash: string | null } | undefined
  if (!row) {
    throw new Error('Unknown WorkItem handoff')
  }
  if (!row.content_hash || handoffContentHash(itemId, row.snapshot) !== row.content_hash) {
    throw new Error('Handoff integrity mismatch or historical capture unverifiable')
  }
  const handoff = JSON.parse(row.snapshot) as HandoffArtifactV0
  if (handoff.handoffId !== id || handoff.workItemId !== itemId) {
    throw new Error('Handoff persisted identity mismatch')
  }
  return handoff
}
