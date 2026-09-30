import { z } from 'zod'
import type { CanonicalMemory } from '../../shared/control-memory-contract'
import type { ControlMemoryStore } from './control-memory-store'
import { canonicalContentHash } from './control-memory-store'
import { isSafeMemoryReference } from './memory-safe-reference'

const Version = z
  .object({
    revision: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
const PromotionInput = z
  .object({
    candidateId: z.string().uuid(),
    expectedCandidate: Version,
    canonicalKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine(isSafeMemoryReference, 'Sensitive memory key rejected'),
    expectedCanonical: Version.nullable()
  })
  .strict()
export type MemoryPromotionRequest = z.input<typeof PromotionInput>

/** Explicit host action only; runtime messages and candidate generation never invoke this gate. */
export class MemoryPromotionGate {
  constructor(private readonly memory: ControlMemoryStore) {}

  promote(input: MemoryPromotionRequest): CanonicalMemory {
    const value = PromotionInput.parse(input)
    return this.memory.work.transaction(() => {
      const candidate = this.memory.get(value.candidateId)
      this.memory.assertVersion(candidate, value.expectedCandidate)
      if (candidate.status !== 'CANDIDATE') {
        throw new Error('Memory candidate is not eligible for promotion')
      }
      this.memory.assertProvenance(candidate)
      const previous = this.memory.canonical(candidate.projectId, value.canonicalKey)
      if (previous) {
        if (!value.expectedCanonical) {
          throw new Error('Canonical memory exists; explicit supersession version required')
        }
        this.memory.assertVersion(previous, value.expectedCanonical)
      } else if (value.expectedCanonical) {
        throw new Error('Expected canonical memory is missing')
      }
      const canonical: CanonicalMemory = {
        projectId: candidate.projectId,
        key: value.canonicalKey,
        statement: candidate.statement,
        kind: candidate.kind,
        sourceCandidateId: candidate.memoryCandidateId,
        sourceEvidenceRefs: candidate.sourceEvidenceRefs,
        sourceArtifactRefs: candidate.sourceArtifactRefs,
        revision: (previous?.revision ?? 0) + 1,
        contentHash: '',
        updatedAt: new Date().toISOString()
      }
      canonical.contentHash = canonicalContentHash(canonical)
      if (previous) {
        const oldCandidate = this.memory.get(previous.sourceCandidateId)
        if (oldCandidate.status !== 'PROMOTED' || oldCandidate.projectId !== candidate.projectId) {
          throw new Error('Canonical provenance changed; reconcile before promotion')
        }
        this.memory.transition(oldCandidate, 'SUPERSEDED')
      }
      this.memory.transition(candidate, 'PROMOTED')
      this.memory.work.native.db
        .prepare(`INSERT INTO control_canonical_memory (project_id,memory_key,snapshot)
        VALUES (?,?,?) ON CONFLICT(project_id,memory_key) DO UPDATE SET snapshot=excluded.snapshot`)
        .run(canonical.projectId, canonical.key, JSON.stringify(canonical))
      this.memory.work.native.db
        .prepare(`INSERT INTO control_memory_promotions
        (project_id,memory_key,candidate_id,previous_snapshot,promoted_snapshot,created_at) VALUES (?,?,?,?,?,?)`)
        .run(
          canonical.projectId,
          canonical.key,
          candidate.memoryCandidateId,
          previous ? JSON.stringify(previous) : null,
          JSON.stringify(canonical),
          canonical.updatedAt
        )
      return canonical
    })
  }
}
