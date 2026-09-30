import { createHash, randomUUID } from 'node:crypto'
import type { TaskJournal } from '../../shared/control-memory-contract'
import type { WorkEvent } from '../../shared/control-core-contract'
import type { ControlWorkStore } from './control-work-store'
import { redactString } from '../observability/redactor'
import { isSafeMemoryReference, safeMemoryReference } from './memory-safe-reference'

export function journalContentHash(journal: Omit<TaskJournal, 'contentHash'>): string {
  return createHash('sha256').update(JSON.stringify(journal)).digest('hex')
}

export class TaskJournalStore {
  constructor(private readonly store: ControlWorkStore) {}

  get(sessionId: string): TaskJournal | null {
    const row = this.store.native.db
      .prepare('SELECT snapshot FROM control_task_journals WHERE session_id=?')
      .get(sessionId) as { snapshot: string } | undefined
    if (!row) {
      return null
    }
    const journal = JSON.parse(row.snapshot) as TaskJournal
    const { contentHash, ...content } = journal
    if (
      journalContentHash(content) !== contentHash ||
      journal.logicalWorkSessionId !== sessionId ||
      [...journal.artifactRefs, ...journal.evidenceRefs].some((ref) => !isSafeMemoryReference(ref))
    ) {
      throw new Error('TaskJournal integrity mismatch')
    }
    return journal
  }

  capture(sessionId: string): TaskJournal {
    return this.store.transaction(() => {
      const existing = this.get(sessionId)
      if (existing) {
        return existing
      }
      const session = this.store.session(sessionId)
      if (session.status !== 'COMPLETED') {
        throw new Error('Only completed logical work can be journaled')
      }
      const items = this.store.items(sessionId)
      if (!items.length || items.some((item) => item.status !== 'VERIFIED')) {
        throw new Error('TaskJournal requires a verified graph')
      }
      const events: WorkEvent[] = []
      let after = 0
      for (;;) {
        const page = this.store.events(sessionId, after)
        if (!page.length) {
          break
        }
        events.push(...page)
        after = page.at(-1)!.sequence
      }
      const attempts = this.store.native.db
        .prepare(`SELECT a.execution_id FROM control_work_attempts a
        JOIN control_work_items i ON i.id=a.item_id WHERE i.session_id=? ORDER BY a.rowid`)
        .all(sessionId) as { execution_id: string | null }[]
      const artifactRefs = new Set(items.flatMap((item) => item.artifactRefs))
      const evidenceRefs = new Set(items.flatMap((item) => item.evidenceRefs))
      for (const event of events) {
        if (event.type === 'ARTIFACT_PUBLISHED' && typeof event.payload.artifactRef === 'string') {
          artifactRefs.add(event.payload.artifactRef)
        }
        if (
          ['WORK_VERIFIED', 'WORK_FAILED'].includes(event.type) &&
          Array.isArray(event.payload.evidenceRefs)
        ) {
          for (const ref of event.payload.evidenceRefs) {
            if (typeof ref === 'string') {
              evidenceRefs.add(ref)
            }
          }
        }
      }
      const content: Omit<TaskJournal, 'contentHash'> = {
        journalId: randomUUID(),
        logicalWorkSessionId: sessionId,
        projectId: session.projectId,
        objective: redactString(session.objective),
        workEventSequences: events.map((event) => event.sequence),
        workItemIds: items.map((item) => item.workItemId),
        executionIds: attempts.flatMap((attempt) =>
          attempt.execution_id ? [attempt.execution_id] : []
        ),
        artifactRefs: [...new Set([...artifactRefs].map(safeMemoryReference))],
        evidenceRefs: [...new Set([...evidenceRefs].map(safeMemoryReference))],
        decisionEventSequences: events
          .filter((event) => event.type === 'DECISION_RECORDED')
          .map((event) => event.sequence),
        failureEventSequences: events
          .filter((event) => ['WORK_FAILED', 'WORK_BLOCKED', 'WORK_CANCELLED'].includes(event.type))
          .map((event) => event.sequence),
        verificationEventSequences: events
          .filter((event) => event.type === 'WORK_VERIFIED')
          .map((event) => event.sequence),
        revision: 1,
        createdAt: new Date().toISOString()
      }
      const journal: TaskJournal = { ...content, contentHash: journalContentHash(content) }
      this.store.native.db
        .prepare(
          'INSERT INTO control_task_journals (id,session_id,project_id,snapshot) VALUES (?,?,?,?)'
        )
        .run(journal.journalId, sessionId, journal.projectId, JSON.stringify(journal))
      return journal
    })
  }
}
