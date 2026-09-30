import { afterEach, describe, expect, it } from 'vitest'
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

describe('PeerMailbox is durable data, never workflow authority', () => {
  it('persists scoped QUESTION and ANSWER with sender and recipient identity', () => {
    const f = setup()
    const { session, item: a } = f.create()
    const b = f.core.addBranch(session.logicalWorkSessionId, { objective: 'Review', branchId: 'b' })
    const question = f.core.sendMessage(a.workItemId, {
      logicalWorkSessionId: session.logicalWorkSessionId,
      toWorkItemId: b.workItemId,
      type: 'QUESTION',
      payload: { question: 'Which artifact?' },
      requiresResponse: true
    })
    const answer = f.core.sendMessage(b.workItemId, {
      logicalWorkSessionId: session.logicalWorkSessionId,
      toWorkItemId: a.workItemId,
      type: 'ANSWER',
      payload: { answerTo: question.messageId },
      artifactRefs: ['artifact:1']
    })
    f.reopen()
    expect(f.core.inbox(b.workItemId)).toEqual([question])
    expect(f.core.inbox(a.workItemId)).toEqual([answer])
    expect(f.core.inbox(a.workItemId, answer.messageId)).toEqual([])
    expect(() => f.core.inbox(a.workItemId, question.messageId)).toThrow(/cursor/)
    expect(
      f.core.events(session.logicalWorkSessionId).filter((e) => e.type === 'MESSAGE_SENT')
    ).toHaveLength(2)
  })

  it.each(['RESULT', 'REVIEW_RESULT', 'SPAWN_PROPOSAL'] as const)(
    '%s cannot verify or spawn work',
    (type) => {
      const f = setup()
      const { session, item } = f.create()
      f.core.sendMessage(item.workItemId, {
        logicalWorkSessionId: session.logicalWorkSessionId,
        toWorkItemId: session.rootWorkItemId,
        type,
        payload: { status: 'VERIFIED', passed: true, requestedBranches: 10 },
        evidenceRefs: ['worker:claim']
      })
      const view = f.core.openSession(session.logicalWorkSessionId)
      expect(view.session.status).toBe('ACTIVE')
      expect(view.items).toHaveLength(2)
      expect(view.items.every((work) => work.status === 'QUEUED')).toBe(true)
      expect(view.events.some((e) => e.type === 'WORK_VERIFIED')).toBe(false)
    }
  )

  it('rejects cross-session messages and forged sender fields atomically', () => {
    const f = setup()
    const a = f.create('A')
    const b = f.create('B')
    const message = {
      logicalWorkSessionId: a.session.logicalWorkSessionId,
      toWorkItemId: b.item.workItemId,
      type: 'QUESTION' as const,
      payload: {}
    }
    expect(() => f.core.sendMessage(a.item.workItemId, message)).toThrow(/cross logical/)
    expect(() =>
      f.core.sendMessage(a.item.workItemId, {
        ...message,
        toWorkItemId: a.session.rootWorkItemId,
        fromWorkItemId: b.item.workItemId
      } as typeof message)
    ).toThrow()
    expect(f.core.inbox(b.item.workItemId)).toEqual([])
    expect(f.db.db.prepare('SELECT COUNT(*) AS n FROM control_peer_messages').get()?.n).toBe(0)
  })

  it('redacts secret-shaped payload fields and bounds oversized messages', () => {
    const f = setup()
    const { session, item } = f.create()
    const message = {
      logicalWorkSessionId: session.logicalWorkSessionId,
      toWorkItemId: session.rootWorkItemId,
      type: 'PROGRESS' as const,
      payload: { apiKey: 'fixture-not-a-real-key' }
    }
    const saved = f.core.sendMessage(item.workItemId, message)
    expect(JSON.stringify(saved.payload)).not.toContain('fixture-not-a-real-key')
    expect(() =>
      f.core.sendMessage(item.workItemId, { ...message, payload: { text: 'x'.repeat(16001) } })
    ).toThrow(/limit/)
    expect(f.core.inbox(session.rootWorkItemId)).toHaveLength(1)
  })
})
