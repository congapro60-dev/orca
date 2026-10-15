import { createHash, randomUUID } from 'node:crypto'
import type { ResumeDecision } from '../../shared/control-evidence-contract'
import type { ControlWorkStore } from './control-work-store'
import { redactString } from '../observability/redactor'

const hash = (itemId: string, snapshot: string) =>
  createHash('sha256')
    .update(JSON.stringify([itemId, snapshot]))
    .digest('hex')

export function writeResumeDecision(
  work: ControlWorkStore,
  input: Omit<ResumeDecision, 'decisionId' | 'createdAt'>
): ResumeDecision {
  work.item(input.workItemId)
  const decision = {
    ...input,
    reason: redactString(input.reason).slice(0, 2000),
    decisionId: randomUUID(),
    createdAt: new Date().toISOString()
  }
  const snapshot = JSON.stringify(decision)
  work.native.db
    .prepare(
      'INSERT INTO control_resume_decisions (id,item_id,snapshot,content_hash,created_at) VALUES (?,?,?,?,?)'
    )
    .run(
      decision.decisionId,
      decision.workItemId,
      snapshot,
      hash(decision.workItemId, snapshot),
      decision.createdAt
    )
  return decision
}

export function readLatestResumeDecision(
  work: ControlWorkStore,
  itemId: string
): ResumeDecision | null {
  work.item(itemId)
  const row = work.native.db
    .prepare(
      'SELECT snapshot,content_hash FROM control_resume_decisions WHERE item_id=? ORDER BY rowid DESC LIMIT 1'
    )
    .get(itemId) as { snapshot: string; content_hash: string | null } | undefined
  if (!row) {
    return null
  }
  if (!row.content_hash || hash(itemId, row.snapshot) !== row.content_hash) {
    throw new Error('Resume decision integrity mismatch or historical capture unverifiable')
  }
  return JSON.parse(row.snapshot) as ResumeDecision
}
