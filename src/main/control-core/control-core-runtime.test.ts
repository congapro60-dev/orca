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

describe('Control Core runtime attempt lifecycle', () => {
  it('serializes admission across logical sessions even on different workspaces', async () => {
    const f = setup()
    const other = setup()
    const { item } = f.create()
    const second = f.core.createSession({
      projectId: 'other-project',
      worktree: other.directory,
      objective: 'Other workspace'
    })
    const secondItem = f.core
      .openSession(second.logicalWorkSessionId)
      .items.find((i) => i.branchId === 'main')!
    const pending = f.core.start(item.workItemId, item.revision)
    await expect(f.core.start(secondItem.workItemId, secondItem.revision)).rejects.toThrow(
      /one WorkItem/
    )
    await pending
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
    await f.core.cancel(item.workItemId)
    expect((await f.core.start(secondItem.workItemId, secondItem.revision)).status).toBe('RUNNING')
  })

  it('replaces an execution without replacing logical session/item and retains attempt history', async () => {
    const f = setup()
    const { session, item } = f.create()
    const first = await f.core.start(item.workItemId, item.revision)
    f.records.get(first.executionId!)!.status = 'FAILED'
    const failed = f.core.refresh(item.workItemId)
    const replacement = await f.core.start(item.workItemId, failed.revision)
    expect(replacement.logicalWorkSessionId).toBe(session.logicalWorkSessionId)
    expect(replacement.workItemId).toBe(item.workItemId)
    expect(replacement.executionId).not.toBe(first.executionId)
    expect(replacement.nativeTaskId).not.toBe(first.nativeTaskId)
    const attempts = f.db.db
      .prepare('SELECT * FROM control_work_attempts WHERE item_id=? ORDER BY rowid')
      .all(item.workItemId)
    expect(attempts.map((a) => a.execution_id)).toEqual([
      first.executionId,
      replacement.executionId
    ])
    f.records.get(replacement.executionId!)!.status = 'COMPLETED'
    f.records.get(replacement.executionId!)!.result = 'New result'
    const recovered = f.reopen().openSession(session.logicalWorkSessionId)
    expect(recovered.items.find((i) => i.workItemId === item.workItemId)?.status).toBe(
      'READY_FOR_REVIEW'
    )
  })

  it('enforces one active item and rejects stale duplicate start before runtime dispatch', async () => {
    const f = setup()
    const { session, item } = f.create()
    const b = f.core.addBranch(session.logicalWorkSessionId, { objective: 'B', branchId: 'b' })
    await f.core.start(item.workItemId, item.revision)
    await expect(f.core.start(item.workItemId, item.revision)).rejects.toThrow(/Stale/)
    await expect(f.core.start(b.workItemId, b.revision)).rejects.toThrow(/one WorkItem/)
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })

  it('cancels queued work locally and running work through the runtime port', async () => {
    const f = setup()
    const a = f.create()
    expect((await f.core.cancel(a.item.workItemId)).status).toBe('CANCELLED')
    expect(f.runtime.cancel).not.toHaveBeenCalled()
    const b = f.create()
    const running = await f.core.start(b.item.workItemId, b.item.revision)
    expect((await f.core.cancel(b.item.workItemId)).status).toBe('CANCELLED')
    expect(f.runtime.cancel).toHaveBeenCalledWith(running.executionId)
    f.reopen()
    expect(f.core.item(b.item.workItemId).cancelRequested).toBe(true)
  })

  it('propagates cancellation requested while start is preparing', async () => {
    const f = setup()
    const { item } = f.create()
    const original = f.runtime.start.getMockImplementation()!
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    f.runtime.start.mockImplementationOnce(async (...args) => {
      await held
      return original(...args)
    })
    const pending = f.core.start(item.workItemId, item.revision)
    expect(f.core.item(item.workItemId).status).toBe('WAITING')
    await f.core.cancel(item.workItemId)
    release()
    expect((await pending).status).toBe('CANCELLED')
    expect(f.runtime.cancel).toHaveBeenCalledTimes(1)
  })

  it('keeps ambiguous execution BLOCKED and cannot verify or retry it', async () => {
    const f = setup()
    const { item } = f.create()
    const running = await f.core.start(item.workItemId, item.revision)
    f.records.get(running.executionId!)!.status = 'OUTCOME_UNKNOWN'
    const blocked = f.core.refresh(item.workItemId)
    expect(blocked.status).toBe('BLOCKED')
    await expect(f.core.start(item.workItemId, blocked.revision)).rejects.toThrow(/cannot start/)
    await expect(f.core.verify(item.workItemId, blocked.revision)).rejects.toThrow(/not ready/)
    const other = setup()
    const next = f.core.createSession({
      projectId: 'other',
      worktree: other.directory,
      objective: 'Other workspace'
    })
    const nextItem = f.core
      .openSession(next.logicalWorkSessionId)
      .items.find((i) => i.branchId === 'main')!
    await expect(f.core.start(nextItem.workItemId, nextItem.revision)).rejects.toThrow(
      /one WorkItem/
    )
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
  })

  it('rejects foreign workspace receipts and empty completed results', async () => {
    const f = setup()
    const { item } = f.create()
    const running = await f.core.start(item.workItemId, item.revision)
    const record = f.records.get(running.executionId!)!
    record.worktree += '-other'
    expect(() => f.core.refresh(item.workItemId)).toThrow(/canonical WorkItem/)
    record.worktree = f.directory
    record.status = 'COMPLETED'
    record.result = '  '
    expect(() => f.core.refresh(item.workItemId)).toThrow(/no result evidence/)
    expect(f.core.item(item.workItemId).status).toBe('RUNNING')
  })

  it('does not regress RUNNING when a delayed STARTING snapshot arrives', async () => {
    const f = setup()
    const { item } = f.create()
    const running = await f.core.start(item.workItemId, item.revision)
    f.records.get(running.executionId!)!.status = 'STARTING'
    expect(f.core.refresh(item.workItemId).status).toBe('RUNNING')
  })
})
