import { afterEach, describe, expect, it } from 'vitest'
import type { CoreRuntimeProfile } from '../../shared/control-core-contract'
import { coreFixture } from './control-core-test-fixture'
import { compileWorkPacket } from './work-packet-compiler'
import { completionBarrier } from './completion-barrier'

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
const profile: CoreRuntimeProfile = { runtime: 'codex', permissionMode: 'READ_ONLY' }

describe('WorkPacket bounds and context isolation', () => {
  it('selects only bounded provided context without mutating canonical state', () => {
    const f = setup()
    const { session, item } = f.create()
    const before = structuredClone({ session, item })
    const packet = compileWorkPacket(
      session,
      item,
      [
        { id: 'relevant', content: 'Evidence for this work only' },
        { id: 'oversized', content: 'x'.repeat(8001) },
        { id: 'small', content: 'Selected second capsule' }
      ],
      profile
    )
    expect(packet.selectedContextIds).toEqual(['relevant', 'small'])
    expect(packet.omittedContextIds).toEqual(['oversized'])
    expect(packet.prompt.length).toBeLessThanOrEqual(32000)
    expect(packet.prompt).toContain(item.doneWhen[0])
    expect(packet.prompt).toContain(item.constraints[0])
    expect(packet.prompt).toContain('not canonical knowledge')
    expect(packet.prompt).not.toContain('oversized')
    expect({ session, item }).toEqual(before)
    expect(f.core.item(item.workItemId)).toEqual(before.item)
    const isolated = compileWorkPacket(
      session,
      item,
      [{ id: 'different', content: 'Other selected context' }],
      profile
    )
    expect(isolated.prompt).not.toContain('Evidence for this work only')
  })

  it('rejects foreign identity, duplicate capsules, unsupported profiles and overbudget prompts', () => {
    const f = setup()
    const { session, item } = f.create()
    expect(() =>
      compileWorkPacket(session, { ...item, logicalWorkSessionId: 'foreign' }, [], profile)
    ).toThrow(/mismatch/)
    expect(() =>
      compileWorkPacket(
        session,
        item,
        [
          { id: 'x', content: 'one' },
          { id: 'x', content: 'two' }
        ],
        profile
      )
    ).toThrow(/unique/)
    expect(() =>
      compileWorkPacket(session, item, [], {
        ...profile,
        permissionMode: 'FULL_ACCESS'
      } as unknown as CoreRuntimeProfile)
    ).toThrow(/Unsupported/)
    expect(() =>
      compileWorkPacket(session, item, [], {
        ...profile,
        permissionMode: 'WORKSPACE_WRITE'
      })
    ).toThrow(/canonical session permission/)
    expect(() =>
      compileWorkPacket(session, { ...item, objective: 'x'.repeat(32000) }, [], profile)
    ).toThrow(/budget/)
  })

  it('bounds capsule count and metadata as well as content', () => {
    const f = setup()
    const { session, item } = f.create()
    expect(() =>
      compileWorkPacket(
        session,
        item,
        Array.from({ length: 65 }, (_, i) => ({ id: String(i), content: '' })),
        profile
      )
    ).toThrow()
    expect(() =>
      compileWorkPacket(session, item, [{ id: 'x'.repeat(129), content: '' }], profile)
    ).toThrow()
  })
})

describe('CompletionBarrier graph integrity', () => {
  it('does not join an empty graph or unverifiable dependencies', () => {
    const f = setup()
    const { session, item } = f.create()
    const root = f.core.item(session.rootWorkItemId)
    expect(completionBarrier([root], root.workItemId).ready).toBe(false)
    expect(
      completionBarrier(
        [root, { ...item, status: 'VERIFIED', dependsOn: ['missing'] }],
        root.workItemId
      ).ready
    ).toBe(false)
  })

  it('rejects disconnected, foreign and cyclic graphs', () => {
    const f = setup()
    const { session, item } = f.create()
    const root = f.core.item(session.rootWorkItemId)
    expect(() =>
      completionBarrier([root, { ...item, parentWorkItemId: 'missing' }], root.workItemId)
    ).toThrow(/disconnected/)
    expect(() =>
      completionBarrier([root, { ...item, logicalWorkSessionId: 'foreign' }], root.workItemId)
    ).toThrow(/foreign/)
    expect(() =>
      completionBarrier([root, { ...item, parentWorkItemId: item.workItemId }], root.workItemId)
    ).toThrow(/cycle/)
  })
})
