import { afterEach, describe, expect, it } from 'vitest'
import { ControlCoreFacade } from './control-core-facade'
import { coreFixture } from './control-core-test-fixture'

const fixtures: ReturnType<typeof coreFixture>[] = []
function setup() {
  const fixture = coreFixture()
  fixtures.push(fixture)
  return fixture
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.dispose()
  }
})

describe('Control Core canonical graph and verification', () => {
  it('retries rejected work within the same logical identity while retaining prior evidence', async () => {
    const f = setup()
    const { session, item } = f.create()
    const first = await f.complete(item.workItemId)
    const published = f.core.publishArtifact(
      item.workItemId,
      first.revision,
      'artifact:first-attempt'
    )
    f.verifier.verify.mockResolvedValueOnce({
      passed: false,
      evidenceRefs: ['review:incorrect-result'],
      reason: 'Required evidence missing'
    })
    const rejected = await f.core.verify(item.workItemId, published.revision)
    expect(rejected.status).toBe('FAILED')
    expect(f.core.openSession(session.logicalWorkSessionId).session.status).toBe('ACTIVE')
    const second = await f.complete(item.workItemId)
    expect(second.executionId).not.toBe(first.executionId)
    expect(second.logicalWorkSessionId).toBe(first.logicalWorkSessionId)
    expect(f.records.get(first.executionId!)?.result).toContain('fixture result')
    await f.core.verify(item.workItemId, second.revision)
    const restored = f.reopen().openSession(session.logicalWorkSessionId)
    expect(restored.session.status).toBe('COMPLETED')
    expect(restored.events.find((e) => e.type === 'ARTIFACT_PUBLISHED')?.payload.artifactRef).toBe(
      'artifact:first-attempt'
    )
    expect(restored.events.find((e) => e.type === 'WORK_FAILED')?.payload).toMatchObject({
      executionId: first.executionId,
      verification: 'rejected',
      evidenceRefs: ['review:incorrect-result']
    })
    expect(
      f.db.db
        .prepare('SELECT COUNT(*) AS n FROM control_work_attempts WHERE item_id=?')
        .get(item.workItemId)?.n
    ).toBe(2)
  })

  it('completes a single node only after host verification and restores it after reopen', async () => {
    const f = setup()
    const { session, item } = f.create()
    const ready = await f.complete(item.workItemId)
    expect(ready.status).toBe('READY_FOR_REVIEW')
    expect(f.core.openSession(session.logicalWorkSessionId).session.status).toBe('ACTIVE')
    expect(f.core.item(session.rootWorkItemId).status).toBe('QUEUED')
    const verified = await f.core.verify(item.workItemId, ready.revision)
    expect(verified.status).toBe('VERIFIED')
    expect(f.core.item(session.rootWorkItemId).status).toBe('VERIFIED')
    const restored = f.reopen().openSession(session.logicalWorkSessionId)
    expect(restored.session.status).toBe('COMPLETED')
    expect(restored.items.find((i) => i.workItemId === item.workItemId)).toEqual(verified)
    expect(restored.events.map((e) => e.type)).toContain('JOIN_READY')
    expect(f.db.getRun(session.runId)).toBeDefined()
  })

  it('A verified alone does not join; A and dependent B verified complete the root', async () => {
    const f = setup()
    const { session, item: a } = f.create()
    const b = f.core.addBranch(session.logicalWorkSessionId, {
      objective: 'Review A',
      branchId: 'review',
      dependsOn: [a.workItemId]
    })
    await expect(f.core.start(b.workItemId, b.revision)).rejects.toThrow(/dependencies/)
    const readyA = await f.complete(a.workItemId)
    await f.core.verify(a.workItemId, readyA.revision)
    expect(
      f.core.events(session.logicalWorkSessionId).filter((e) => e.type === 'JOIN_READY')
    ).toHaveLength(0)
    expect(f.core.item(session.rootWorkItemId).status).toBe('QUEUED')
    const readyB = await f.complete(b.workItemId)
    await f.core.verify(b.workItemId, readyB.revision)
    expect(
      f.core.events(session.logicalWorkSessionId).filter((e) => e.type === 'JOIN_READY')
    ).toHaveLength(1)
    expect(f.core.openSession(session.logicalWorkSessionId).session.status).toBe('COMPLETED')
    expect(() =>
      f.core.addBranch(session.logicalWorkSessionId, { objective: 'late', branchId: 'late' })
    ).toThrow(/closed/)
  })

  it('rejects stale revisions and prevents a verifier race from rewriting new evidence', async () => {
    const f = setup()
    const { item } = f.create()
    const ready = await f.complete(item.workItemId)
    await expect(f.core.verify(item.workItemId, item.revision)).rejects.toThrow(/Stale/)
    f.verifier.verify.mockImplementationOnce(async () => {
      f.core.publishArtifact(item.workItemId, ready.revision, 'artifact:new')
      return { passed: true, evidenceRefs: ['test:old-review'] }
    })
    await expect(f.core.verify(item.workItemId, ready.revision)).rejects.toThrow(/changed during/)
    expect(f.core.item(item.workItemId).status).toBe('READY_FOR_REVIEW')
    expect(f.core.item(item.workItemId).artifactRefs).toEqual(['artifact:new'])
  })

  it('fails closed without a configured verifier or without evidence', async () => {
    const f = setup()
    const { item } = f.create()
    const ready = await f.complete(item.workItemId)
    const withoutVerifier = new ControlCoreFacade(f.db, f.runtime, f.environment)
    await expect(withoutVerifier.verify(item.workItemId, ready.revision)).rejects.toThrow(
      /not configured/
    )
    f.verifier.verify.mockResolvedValueOnce({ passed: true, evidenceRefs: [] })
    await expect(f.core.verify(item.workItemId, ready.revision)).rejects.toThrow(
      /requires evidence/
    )
    expect(f.core.item(item.workItemId).status).toBe('READY_FOR_REVIEW')
  })

  it('prevents direct root execution, root cancellation, and premature verification', async () => {
    const f = setup()
    const { session, item } = f.create()
    await expect(f.core.start(session.rootWorkItemId, 0)).rejects.toThrow(/cannot start/)
    await expect(f.core.cancel(session.rootWorkItemId)).rejects.toThrow(/Control Core/)
    await expect(f.core.verify(item.workItemId, 0)).rejects.toThrow(/not ready/)
    expect(f.runtime.start).not.toHaveBeenCalled()
  })

  it('rolls back the native run and graph if session criteria are invalid', () => {
    const f = setup()
    const before = f.db.db.prepare('SELECT COUNT(*) AS n FROM runs').get()
    expect(() =>
      f.core.createSession({
        projectId: 'p',
        worktree: f.directory,
        objective: 'Bounded',
        doneWhen: ['x'.repeat(1001)]
      })
    ).toThrow()
    expect(f.core.listSessions('p')).toEqual([])
    expect(f.db.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual(before)
    expect(f.db.db.prepare('SELECT COUNT(*) AS n FROM control_work_events').get()?.n).toBe(0)
  })

  it('protects logical state from legacy resets and keeps normal legacy reset available', () => {
    const f = setup()
    expect(() => f.db.resetTasks()).not.toThrow()
    const { session } = f.create()
    expect(() => f.db.resetTasks()).toThrow(/Control Core/)
    expect(() => f.db.resetAll()).toThrow(/Control Core/)
    expect(f.core.openSession(session.logicalWorkSessionId).items).toHaveLength(2)
    expect(() => f.db.resetMessages()).not.toThrow()
  })
})
