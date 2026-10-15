import { describe, expect, it, vi } from 'vitest'
import type { CodexRuntimeReceipt } from '../../shared/codex-runtime-contract'
import { CodexRuntimeTurnEvents } from './codex-runtime-turn-events'

function fixture() {
  const receipt = { threadId: 'thread-a', turnId: null } as CodexRuntimeReceipt
  const events = new CodexRuntimeTurnEvents(receipt, vi.fn())
  const emit = (id: string, turnId = 'turn-a', threadId = 'thread-a', exitCode: unknown = 1) =>
    events.accept('item/completed', {
      threadId,
      turnId,
      item: {
        id,
        type: 'commandExecution',
        command: 'test token=fixture-secret',
        status: 'completed',
        exitCode
      }
    })
  return { receipt, events, emit }
}

describe('Correlated bounded Codex command evidence', () => {
  it('selects only the acknowledged turn, including events arriving before its acknowledgement', () => {
    const { receipt, events, emit } = fixture()
    emit('foreign', 'turn-a', 'foreign-thread')
    emit('other', 'turn-b')
    emit('command-a')
    expect(events.commandEvidence()).toBeNull()
    receipt.turnId = 'turn-a'
    emit('late-other', 'turn-b')
    const commands = events.commandEvidence()!
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ itemId: 'command-a', exitCode: 1, status: 'completed' })
    expect(commands[0].command).not.toContain('fixture-secret')
    commands[0].exitCode = 0
    expect(events.commandEvidence()![0].exitCode).toBe(1)
  })

  it('distinguishes zero commands from missing capture and deduplicates identical completion', () => {
    const { receipt, events, emit } = fixture()
    receipt.turnId = 'turn-a'
    expect(events.commandEvidence()).toEqual([])
    emit('command-a', 'turn-a', 'thread-a', null)
    emit('command-a', 'turn-a', 'thread-a', null)
    expect(events.commandEvidence()).toHaveLength(1)
    expect(events.commandEvidence()![0].exitCode).toBeNull()
    expect(() => emit('command-a')).toThrow(/Conflicting/)
  })

  it('refuses malformed exit codes and overflow instead of silently truncating command count', () => {
    const { receipt, events, emit } = fixture()
    receipt.turnId = 'turn-a'
    expect(() => emit('invalid', 'turn-a', 'thread-a', '0')).toThrow(/exit code/)
    for (let i = 0; i < 64; i++) {
      emit(`command-${i}`)
    }
    expect(() => emit('overflow')).toThrow(/count exceeds bound/)
    expect(events.commandEvidence()).toHaveLength(64)
  })
})
