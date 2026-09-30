import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CandidateMemory, CanonicalMemory } from '../../shared/control-memory-contract'
import { redactString } from '../observability/redactor'
import type { ControlWorkStore } from './control-work-store'
import { TaskJournalStore } from './task-journal'
import { isSafeMemoryReference } from './memory-safe-reference'

const References = z
  .array(
    z.string().min(1).max(1000).refine(isSafeMemoryReference, 'Sensitive memory reference rejected')
  )
  .max(64)
const CandidateInput = z
  .object({
    logicalWorkSessionId: z.string().uuid(),
    statement: z.string().trim().min(1).max(4000),
    kind: z.string().trim().min(1).max(64),
    sourceEvidenceRefs: References.min(1),
    sourceArtifactRefs: References.default([])
  })
  .strict()
export type NewCandidateMemory = z.input<typeof CandidateInput>
export type MemoryVersion = { revision: number; contentHash: string }

export function candidateContentHash(memory: CandidateMemory): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        projectId: memory.projectId,
        logicalWorkSessionId: memory.logicalWorkSessionId,
        sourceJournalId: memory.sourceJournalId,
        statement: memory.statement,
        kind: memory.kind,
        sourceEvidenceRefs: memory.sourceEvidenceRefs,
        sourceArtifactRefs: memory.sourceArtifactRefs
      })
    )
    .digest('hex')
}
export function canonicalContentHash(memory: CanonicalMemory): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        projectId: memory.projectId,
        key: memory.key,
        statement: memory.statement,
        kind: memory.kind,
        sourceCandidateId: memory.sourceCandidateId,
        sourceEvidenceRefs: memory.sourceEvidenceRefs,
        sourceArtifactRefs: memory.sourceArtifactRefs
      })
    )
    .digest('hex')
}

export class ControlMemoryStore {
  readonly journals: TaskJournalStore
  constructor(readonly work: ControlWorkStore) {
    this.journals = new TaskJournalStore(work)
  }

  create(input: NewCandidateMemory): CandidateMemory {
    const value = CandidateInput.parse(input)
    return this.work.transaction(() => {
      const journal = this.journals.capture(value.logicalWorkSessionId)
      const now = new Date().toISOString()
      const candidate: CandidateMemory = {
        ...value,
        projectId: journal.projectId,
        sourceJournalId: journal.journalId,
        memoryCandidateId: randomUUID(),
        statement: redactString(value.statement),
        kind: redactString(value.kind),
        status: 'CANDIDATE',
        revision: 1,
        contentHash: '',
        createdAt: now,
        updatedAt: now
      }
      this.assertProvenance(candidate)
      candidate.contentHash = candidateContentHash(candidate)
      this.work.native.db
        .prepare(`INSERT INTO control_memory_candidates
        (id,project_id,session_id,journal_id,statement,kind,evidence_refs,artifact_refs,status,revision,content_hash,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          candidate.memoryCandidateId,
          candidate.projectId,
          candidate.logicalWorkSessionId,
          candidate.sourceJournalId,
          candidate.statement,
          candidate.kind,
          JSON.stringify(candidate.sourceEvidenceRefs),
          JSON.stringify(candidate.sourceArtifactRefs),
          candidate.status,
          candidate.revision,
          candidate.contentHash,
          now,
          now
        )
      return candidate
    })
  }

  get(id: string): CandidateMemory {
    const row = this.work.native.db
      .prepare(`SELECT id AS memoryCandidateId,project_id AS projectId,
      session_id AS logicalWorkSessionId,journal_id AS sourceJournalId,statement,kind,
      evidence_refs AS sourceEvidenceRefs,artifact_refs AS sourceArtifactRefs,status,revision,
      content_hash AS contentHash,created_at AS createdAt,updated_at AS updatedAt
      FROM control_memory_candidates WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined
    if (!row) {
      throw new Error('Unknown memory candidate')
    }
    row.sourceEvidenceRefs = References.parse(JSON.parse(row.sourceEvidenceRefs as string))
    row.sourceArtifactRefs = References.parse(JSON.parse(row.sourceArtifactRefs as string))
    const candidate = row as CandidateMemory
    if (candidateContentHash(candidate) !== candidate.contentHash) {
      throw new Error('Candidate memory integrity mismatch')
    }
    return candidate
  }

  list(projectId: string): CandidateMemory[] {
    const rows = this.work.native.db
      .prepare(
        'SELECT id FROM control_memory_candidates WHERE project_id=? ORDER BY rowid DESC LIMIT 100'
      )
      .all(projectId) as { id: string }[]
    return rows.map((row) => this.get(row.id))
  }

  canonical(projectId: string, key: string): CanonicalMemory | null {
    const row = this.work.native.db
      .prepare('SELECT snapshot FROM control_canonical_memory WHERE project_id=? AND memory_key=?')
      .get(projectId, key) as { snapshot: string } | undefined
    if (!row) {
      return null
    }
    const memory = JSON.parse(row.snapshot) as CanonicalMemory
    if (
      memory.projectId !== projectId ||
      memory.key !== key ||
      [...memory.sourceArtifactRefs, ...memory.sourceEvidenceRefs].some(
        (ref) => !isSafeMemoryReference(ref)
      ) ||
      canonicalContentHash(memory) !== memory.contentHash
    ) {
      throw new Error('Canonical memory integrity mismatch')
    }
    return memory
  }

  assertProvenance(candidate: CandidateMemory): void {
    const journal = this.journals.get(candidate.logicalWorkSessionId)
    if (
      !journal ||
      journal.logicalWorkSessionId !== candidate.logicalWorkSessionId ||
      journal.journalId !== candidate.sourceJournalId ||
      journal.projectId !== candidate.projectId ||
      !candidate.sourceEvidenceRefs.length ||
      candidate.sourceEvidenceRefs.some((ref) => !journal.evidenceRefs.includes(ref)) ||
      candidate.sourceArtifactRefs.some((ref) => !journal.artifactRefs.includes(ref))
    ) {
      throw new Error('Candidate references must belong to its completed session journal')
    }
  }

  transition(candidate: CandidateMemory, status: CandidateMemory['status']): CandidateMemory {
    const result = this.work.native.db
      .prepare(`UPDATE control_memory_candidates SET status=?,revision=revision+1,updated_at=?
      WHERE id=? AND revision=? AND content_hash=? AND status=?`)
      .run(
        status,
        new Date().toISOString(),
        candidate.memoryCandidateId,
        candidate.revision,
        candidate.contentHash,
        candidate.status
      )
    if (result.changes !== 1) {
      throw new Error('Stale memory candidate revision/hash')
    }
    return this.get(candidate.memoryCandidateId)
  }

  reject(id: string, expected: MemoryVersion): CandidateMemory {
    return this.work.transaction(() => {
      const candidate = this.get(id)
      this.assertVersion(candidate, expected)
      if (candidate.status !== 'CANDIDATE') {
        throw new Error('Only candidate memory can be rejected')
      }
      return this.transition(candidate, 'REJECTED')
    })
  }

  assertVersion(actual: MemoryVersion, expected: MemoryVersion): void {
    if (actual.revision !== expected.revision || actual.contentHash !== expected.contentHash) {
      throw new Error('Stale memory revision/hash; reconcile before mutation')
    }
  }
}
