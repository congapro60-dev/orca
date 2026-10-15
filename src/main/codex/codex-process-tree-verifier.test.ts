import { describe, expect, it } from 'vitest'
import { verifyCodexProcessTreeExited } from './codex-process-tree-verifier'

describe('Codex process-tree exit verification', () => {
  it('requires the host snapshot to omit root and descendants', async () => {
    const read = async () => [
      { pid: 10, ppid: 1, name: 'codex', command: '' },
      { pid: 11, ppid: 10, name: 'node', command: '' }
    ]
    expect(await verifyCodexProcessTreeExited(10, read)).toBe('unverifiable')
    expect(
      await verifyCodexProcessTreeExited(10, async () => [
        { pid: process.pid, ppid: 1, name: 'vitest', command: '' }
      ])
    ).toBe('unverifiable')
  })

  it('keeps unavailable, malformed and PID-missing observations unverifiable', async () => {
    expect(await verifyCodexProcessTreeExited(null, async () => [])).toBe('unverifiable')
    expect(
      await verifyCodexProcessTreeExited(10, async () => {
        throw new Error('unavailable')
      })
    ).toBe('unverifiable')
  })

  it('does not mistake an unrelated process for the old tree', async () => {
    expect(
      await verifyCodexProcessTreeExited(10, async () => [
        { pid: process.pid, ppid: 1, name: 'vitest', command: '' },
        { pid: 99, ppid: 1, name: 'other', command: '' }
      ])
    ).toBe('unverifiable')
  })
})
