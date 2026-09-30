import { afterEach, describe, expect, it } from 'vitest'
import type { NewCandidateMemory } from './control-memory-store'
import { coreFixture } from './control-core-test-fixture'

const fixtures: ReturnType<typeof coreFixture>[] = []
function setup() {
  const f = coreFixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.dispose()
  }
})

async function completed(f: ReturnType<typeof coreFixture>, objective = 'Inspect memory evidence') {
  const { session, item } = f.create(objective)
  f.core.recordDecision(session.logicalWorkSessionId, 'Use read-only evidence')
  const ready = await f.complete(item.workItemId)
  const artifact = f.core.publishArtifact(
    item.workItemId,
    ready.revision,
    `artifact:${item.workItemId}`
  )
  await f.core.verify(item.workItemId, artifact.revision)
  const journal = f.core.journal(session.logicalWorkSessionId)!
  return { session, item, journal }
}

async function candidate(f: ReturnType<typeof coreFixture>, statement = 'Use bounded context') {
  const state = await completed(f)
  const memory = f.core.createMemoryCandidate({
    logicalWorkSessionId: state.session.logicalWorkSessionId,
    statement,
    kind: 'lesson',
    sourceEvidenceRefs: [state.journal.evidenceRefs[0]],
    sourceArtifactRefs: [state.journal.artifactRefs[0]]
  })
  return { ...state, memory }
}

describe('TaskJournal references canonical history without transcript copying', () => {
  it('captures paginated events and failed-attempt references, without rewriting old evidence', async () => {
    const f = setup()
    const { session, item } = f.create()
    for (let index = 0; index < 501; index++) {
      f.core.recordDecision(session.logicalWorkSessionId, `Decision ${index}`)
    }
    const first = await f.complete(item.workItemId)
    const firstArtifact = f.core.publishArtifact(
      item.workItemId,
      first.revision,
      'artifact:old-attempt'
    )
    f.verifier.verify.mockResolvedValueOnce({
      passed: false,
      evidenceRefs: ['review:first-attempt'],
      reason: 'Retry required'
    })
    await f.core.verify(item.workItemId, firstArtifact.revision)
    const second = await f.complete(item.workItemId)
    await f.core.verify(item.workItemId, second.revision)
    const journal = f.core.journal(session.logicalWorkSessionId)!
    expect(journal.decisionEventSequences).toHaveLength(501)
    expect(journal.executionIds).toEqual([first.executionId, second.executionId])
    expect(journal.artifactRefs).toContain('artifact:old-attempt')
    expect(journal.evidenceRefs).toContain('review:first-attempt')
    expect(journal.failureEventSequences).toHaveLength(1)
    expect(journal.verificationEventSequences).toHaveLength(2)
  })

  it('rolls back graph verification if durable journal creation fails', async () => {
    const f = setup()
    const { session, item } = f.create()
    const ready = await f.complete(item.workItemId)
    f.db.db.exec(`CREATE TRIGGER fixture_reject_journal BEFORE INSERT ON control_task_journals
      BEGIN SELECT RAISE(ABORT, 'fixture journal persistence failure'); END`)
    await expect(f.core.verify(item.workItemId, ready.revision)).rejects.toThrow(
      /journal persistence/
    )
    expect(f.core.item(item.workItemId).status).toBe('READY_FOR_REVIEW')
    expect(f.core.item(session.rootWorkItemId).status).toBe('QUEUED')
    expect(f.core.openSession(session.logicalWorkSessionId).session.status).toBe('ACTIVE')
    expect(
      f.core.events(session.logicalWorkSessionId).some((event) => event.type === 'WORK_VERIFIED')
    ).toBe(false)
  })

  it('is captured on completion and survives reopen with a stable content hash', async () => {
    const f = setup()
    const { session, item, journal } = await completed(f)
    expect(
      f.db.db
        .prepare('SELECT id FROM control_task_journals WHERE session_id=?')
        .get(session.logicalWorkSessionId)?.id
    ).toBe(journal.journalId)
    expect(journal.workItemIds).toEqual([session.rootWorkItemId, item.workItemId])
    expect(journal.executionIds).toEqual([f.core.item(item.workItemId).executionId])
    expect(journal.workEventSequences.length).toBeGreaterThan(0)
    expect(journal.decisionEventSequences).toHaveLength(1)
    expect(journal.verificationEventSequences).toHaveLength(2)
    expect(JSON.stringify(journal)).not.toContain('fixture result')
    f.reopen()
    expect(f.core.journal(session.logicalWorkSessionId)).toEqual(journal)
    expect(() => f.core.recordDecision(session.logicalWorkSessionId, 'Late mutation')).toThrow(
      /closed/
    )
  })

  it('does not journal unverified work or create evidence-free candidates', () => {
    const f = setup()
    const { session } = f.create()
    expect(f.core.journal(session.logicalWorkSessionId)).toBeNull()
    expect(() =>
      f.core.createMemoryCandidate({
        logicalWorkSessionId: session.logicalWorkSessionId,
        statement: 'Unproved',
        kind: 'lesson',
        sourceEvidenceRefs: ['invented']
      })
    ).toThrow(/completed/)
    expect(f.core.memoryCandidates('project-test')).toEqual([])
  })
})

describe('CandidateMemory and explicit host PromotionGate', () => {
  it('rolls back candidate and canonical changes if the promotion ledger cannot persist', async () => {
    const f = setup()
    const { memory } = await candidate(f)
    f.db.db.exec(`CREATE TRIGGER fixture_reject_promotion BEFORE INSERT ON control_memory_promotions
      BEGIN SELECT RAISE(ABORT, 'fixture promotion persistence failure'); END`)
    expect(() =>
      f.core.promoteMemory({
        candidateId: memory.memoryCandidateId,
        expectedCandidate: { revision: memory.revision, contentHash: memory.contentHash },
        canonicalKey: 'policy',
        expectedCanonical: null
      })
    ).toThrow(/promotion persistence/)
    expect(f.core.memoryCandidates(memory.projectId)).toEqual([memory])
    expect(f.core.canonicalMemory(memory.projectId, 'policy')).toBeNull()
  })

  it('persists a candidate but cannot change canonical knowledge until explicit promotion', async () => {
    const f = setup()
    const { memory, journal } = await candidate(f)
    expect(memory.status).toBe('CANDIDATE')
    expect(f.core.canonicalMemory(memory.projectId, 'context-policy')).toBeNull()
    expect(memory.sourceJournalId).toBe(journal.journalId)
    f.reopen()
    expect(f.core.memoryCandidates(memory.projectId)).toEqual([memory])
    const promoted = f.core.promoteMemory({
      candidateId: memory.memoryCandidateId,
      expectedCandidate: {
        revision: memory.revision,
        contentHash: memory.contentHash
      },
      canonicalKey: 'context-policy',
      expectedCanonical: null
    })
    expect(promoted.statement).toBe(memory.statement)
    expect(f.core.memoryCandidates(memory.projectId)[0].status).toBe('PROMOTED')
    f.reopen()
    expect(f.core.canonicalMemory(memory.projectId, 'context-policy')).toEqual(promoted)
  })

  it('rejects worker-supplied status and cross-session evidence without writing candidates', async () => {
    const f = setup()
    const a = await completed(f, 'A')
    const b = await completed(f, 'B')
    const input = {
      logicalWorkSessionId: a.session.logicalWorkSessionId,
      statement: 'Claim',
      kind: 'lesson',
      sourceEvidenceRefs: [b.journal.evidenceRefs[0]]
    }
    expect(() => f.core.createMemoryCandidate(input)).toThrow(/belong/)
    expect(() =>
      f.core.createMemoryCandidate({
        ...input,
        sourceEvidenceRefs: a.journal.evidenceRefs,
        status: 'PROMOTED'
      } as NewCandidateMemory)
    ).toThrow()
    expect(f.core.memoryCandidates(a.session.projectId)).toEqual([])
  })

  it('rejects stale candidate revision/hash and prevents re-promoting rejected memory', async () => {
    const f = setup()
    const { memory } = await candidate(f)
    const input = {
      candidateId: memory.memoryCandidateId,
      canonicalKey: 'policy',
      expectedCanonical: null,
      expectedCandidate: { revision: memory.revision, contentHash: memory.contentHash }
    }
    expect(() =>
      f.core.promoteMemory({
        ...input,
        expectedCandidate: { ...input.expectedCandidate, revision: 2 }
      })
    ).toThrow(/Stale/)
    expect(() =>
      f.core.promoteMemory({
        ...input,
        expectedCandidate: { ...input.expectedCandidate, contentHash: '0'.repeat(64) }
      })
    ).toThrow(/Stale/)
    const rejected = f.core.rejectMemoryCandidate(memory.memoryCandidateId, memory)
    expect(rejected.status).toBe('REJECTED')
    expect(rejected.revision).toBe(memory.revision + 1)
    expect(() =>
      f.core.promoteMemory({
        ...input,
        expectedCandidate: { revision: rejected.revision, contentHash: rejected.contentHash }
      })
    ).toThrow(/eligible/)
    expect(f.core.canonicalMemory(memory.projectId, 'policy')).toBeNull()
  })

  it('requires explicit canonical version for supersession and preserves historical evidence', async () => {
    const f = setup()
    const a = await candidate(f, 'Old supported fact')
    const old = f.core.promoteMemory({
      candidateId: a.memory.memoryCandidateId,
      expectedCandidate: { revision: a.memory.revision, contentHash: a.memory.contentHash },
      canonicalKey: 'project-fact',
      expectedCanonical: null
    })
    const b = await candidate(f, 'Newer supported fact')
    const request = {
      candidateId: b.memory.memoryCandidateId,
      expectedCandidate: { revision: b.memory.revision, contentHash: b.memory.contentHash },
      canonicalKey: 'project-fact',
      expectedCanonical: null
    }
    expect(() => f.core.promoteMemory(request)).toThrow(/supersession/)
    expect(() =>
      f.core.promoteMemory({
        ...request,
        expectedCanonical: { revision: old.revision + 1, contentHash: old.contentHash }
      })
    ).toThrow(/Stale/)
    const updated = f.core.promoteMemory({
      ...request,
      expectedCanonical: { revision: old.revision, contentHash: old.contentHash }
    })
    expect(updated.revision).toBe(2)
    expect(updated.statement).toBe('Newer supported fact')
    expect(
      f.core
        .memoryCandidates(a.memory.projectId)
        .find((m) => m.memoryCandidateId === a.memory.memoryCandidateId)?.status
    ).toBe('SUPERSEDED')
    expect(f.core.journal(a.session.logicalWorkSessionId)).toEqual(a.journal)
    const history = f.db.db
      .prepare('SELECT previous_snapshot FROM control_memory_promotions WHERE candidate_id=?')
      .get(b.memory.memoryCandidateId)
    expect(JSON.parse(history!.previous_snapshot as string)).toEqual(old)
    f.reopen()
    expect(f.core.journal(a.session.logicalWorkSessionId)).toEqual(a.journal)
    expect(f.core.canonicalMemory(a.memory.projectId, 'project-fact')).toEqual(updated)
  })

  it('redacts secret-shaped candidate text before it can become canonical', async () => {
    const f = setup()
    const { memory } = await candidate(f, 'Use token=fixture-sensitive-value for this case')
    expect(memory.statement).not.toContain('fixture-sensitive-value')
    expect(memory.statement).toContain('[redacted:')
  })
})
