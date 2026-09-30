import { afterEach, describe, expect, it } from 'vitest'
import { coreFixture } from './control-core-test-fixture'
import { isSafeMemoryReference, safeMemoryReference } from './memory-safe-reference'

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

async function candidate(
  f: ReturnType<typeof coreFixture>,
  artifact = 'artifact:safe',
  projectId = 'project-test'
) {
  const session = f.core.createSession({ projectId, worktree: f.directory, objective: 'Inspect' })
  const item = f.core
    .openSession(session.logicalWorkSessionId)
    .items.find((work) => work.branchId === 'main')!
  const ready = await f.complete(item.workItemId)
  const published = f.core.publishArtifact(item.workItemId, ready.revision, artifact)
  await f.core.verify(item.workItemId, published.revision)
  const journal = f.core.journal(session.logicalWorkSessionId)!
  const memory = f.core.createMemoryCandidate({
    logicalWorkSessionId: session.logicalWorkSessionId,
    statement: 'Evidence-backed lesson',
    kind: 'lesson',
    sourceArtifactRefs: journal.artifactRefs,
    sourceEvidenceRefs: [
      journal.evidenceRefs.find((ref) => ref.startsWith('redacted-ref:')) ?? journal.evidenceRefs[0]
    ]
  })
  const request = {
    candidateId: memory.memoryCandidateId,
    canonicalKey: 'policy',
    expectedCanonical: null,
    expectedCandidate: { revision: memory.revision, contentHash: memory.contentHash }
  }
  return { session, item, journal, memory, request }
}

describe('Memory provenance and sensitive reference boundary', () => {
  it.each([
    'https://user:password@example.test/report',
    'postgres://user:password@example.test/data',
    'https://example.test/report?%74oken=fixture-secret',
    'https://example.test/report?X-Amz-Signature=fixture-signature',
    'https://example.test/report#access_token=fixture-sensitive-value',
    '//fixture-user:fixture-pass@example.test/report'
  ])('does not retain authentication or signed URL material in %s', (reference) => {
    expect(isSafeMemoryReference(reference)).toBe(false)
    expect(safeMemoryReference(reference)).toMatch(/^redacted-ref:sha256:[a-f0-9]{64}$/)
  })

  it('uses opaque sensitive references through journal, promotion and reopen without rewriting source', async () => {
    const f = setup()
    const rawArtifact = 'https://fixture-user:fixture-pass@example.test/report'
    const rawEvidence = 'https://audit-user:audit-pass@example.test/evidence'
    f.verifier.verify.mockResolvedValueOnce({ passed: true, evidenceRefs: [rawEvidence] })
    const state = await candidate(f, rawArtifact)
    expect(f.core.item(state.item.workItemId).artifactRefs).toContain(rawArtifact)
    expect(f.core.item(state.item.workItemId).evidenceRefs).toContain(rawEvidence)
    expect(state.journal.artifactRefs[0]).toMatch(/^redacted-ref:sha256:[a-f0-9]{64}$/)
    expect(state.journal.evidenceRefs.some((ref) => ref.startsWith('redacted-ref:'))).toBe(true)
    expect(() =>
      f.core.createMemoryCandidate({
        logicalWorkSessionId: state.session.logicalWorkSessionId,
        statement: 'Raw locator',
        kind: 'lesson',
        sourceEvidenceRefs: [rawEvidence]
      })
    ).toThrow(/Sensitive/)
    f.core.promoteMemory(state.request)
    f.reopen()
    expect(f.core.journal(state.session.logicalWorkSessionId)).toEqual(state.journal)
    expect(f.core.item(state.item.workItemId).artifactRefs).toContain(rawArtifact)
    const allMemoryRows = [
      ...f.db.db.prepare('SELECT * FROM control_task_journals').all(),
      ...f.db.db.prepare('SELECT * FROM control_memory_candidates').all(),
      ...f.db.db.prepare('SELECT * FROM control_canonical_memory').all(),
      ...f.db.db.prepare('SELECT * FROM control_memory_promotions').all()
    ]
    expect(JSON.stringify(allMemoryRows)).not.toMatch(
      /fixture-pass|audit-pass|fixture-user|audit-user/
    )
  })

  it.each([
    'https://example.test/report#access_token=fixture-sensitive-value',
    '//fixture-user:fixture-pass@example.test/report'
  ])(
    'keeps fragment/protocol-relative credentials out of every memory table: %s',
    async (reference) => {
      const f = setup()
      f.verifier.verify.mockResolvedValueOnce({ passed: true, evidenceRefs: [reference] })
      const state = await candidate(f, reference)
      expect(state.memory.sourceEvidenceRefs[0]).toMatch(/^redacted-ref:sha256:/)
      f.core.promoteMemory(state.request)
      f.reopen()
      expect(f.core.item(state.item.workItemId).artifactRefs).toContain(reference)
      expect(f.core.item(state.item.workItemId).evidenceRefs).toContain(reference)
      for (const table of [
        'control_task_journals',
        'control_memory_candidates',
        'control_canonical_memory',
        'control_memory_promotions'
      ]) {
        const rows = f.db.db.prepare(`SELECT * FROM ${table}`).all()
        expect(JSON.stringify(rows)).not.toContain(reference)
        expect(JSON.stringify(rows)).not.toMatch(
          /fixture-sensitive-value|fixture-user|fixture-pass/
        )
      }
    }
  )

  it('rejects foreign artifacts across both session and project boundaries', async () => {
    const f = setup()
    const a = await candidate(f, 'artifact:a')
    const b = await candidate(f, 'artifact:b')
    const c = await candidate(f, 'artifact:c', 'different-project')
    for (const source of [b, c]) {
      expect(() =>
        f.core.createMemoryCandidate({
          logicalWorkSessionId: a.session.logicalWorkSessionId,
          statement: 'Foreign locator',
          kind: 'lesson',
          sourceEvidenceRefs: [a.journal.evidenceRefs[0]],
          sourceArtifactRefs: source.journal.artifactRefs
        })
      ).toThrow(/belong/)
    }
    expect(f.core.canonicalMemory('different-project', 'policy')).toBeNull()
  })

  it('rejects a wrong canonical hash at the right revision without changing either candidate', async () => {
    const f = setup()
    const a = await candidate(f)
    const old = f.core.promoteMemory(a.request)
    const b = await candidate(f)
    expect(() =>
      f.core.promoteMemory({
        ...b.request,
        expectedCanonical: { revision: old.revision, contentHash: '0'.repeat(64) }
      })
    ).toThrow(/Stale/)
    expect(f.core.canonicalMemory(old.projectId, old.key)).toEqual(old)
    expect(
      f.core
        .memoryCandidates(old.projectId)
        .find((m) => m.memoryCandidateId === b.memory.memoryCandidateId)
    ).toEqual(b.memory)
  })

  it('rolls back supersession and its historical ledger across reopen on persistence failure', async () => {
    const f = setup()
    const a = await candidate(f)
    const old = f.core.promoteMemory(a.request)
    const b = await candidate(f)
    const before = f.core.memoryCandidates(old.projectId)
    const history = f.db.db
      .prepare('SELECT * FROM control_memory_promotions ORDER BY sequence')
      .all()
    f.db.db
      .exec(`CREATE TRIGGER fixture_reject_supersession BEFORE INSERT ON control_memory_promotions
      BEGIN SELECT RAISE(ABORT, 'fixture supersession persistence failure'); END`)
    expect(() =>
      f.core.promoteMemory({
        ...b.request,
        expectedCanonical: { revision: old.revision, contentHash: old.contentHash }
      })
    ).toThrow(/supersession persistence/)
    f.reopen()
    expect(f.core.canonicalMemory(old.projectId, old.key)).toEqual(old)
    expect(f.core.memoryCandidates(old.projectId)).toEqual(before)
    expect(
      f.db.db.prepare('SELECT * FROM control_memory_promotions ORDER BY sequence').all()
    ).toEqual(history)
    expect(f.core.journal(a.session.logicalWorkSessionId)).toEqual(a.journal)
    expect(f.core.journal(b.session.logicalWorkSessionId)).toEqual(b.journal)
  })
})
