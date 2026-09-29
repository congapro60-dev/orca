import { beforeEach, describe, expect, it, vi } from 'vitest'
const call = vi.fn()
vi.mock('../format', () => ({ printResult: vi.fn() }))
import { ORCHESTRATION_HANDLERS } from './orchestration'

function invoke(command: string, entries: [string, string | boolean][]) {
  return ORCHESTRATION_HANDLERS[command]({
    flags: new Map(entries),
    client: { call },
    cwd: '/test/repo',
    json: true
  } as never)
}

describe('programmatic Codex CLI contracts', () => {
  beforeEach(() => call.mockReset())

  it('sends only canonical task identity and safe mode, never executable/profile/secret input', async () => {
    call.mockResolvedValue({
      result: { execution: { executionId: 'exec-1', dispatchId: 'ctx-1', status: 'STARTING' } }
    })
    await invoke('orchestration codex-start', [
      ['task', 'task-1'],
      ['run', 'run-1'],
      ['from', 'coord'],
      ['model', 'reported-model'],
      ['timeout-ms', '60000'],
      ['retry-request', 'idempotent-1']
    ])
    expect(call).toHaveBeenCalledWith(
      'orchestration.codexStartV1',
      {
        task: 'task-1',
        run: 'run-1',
        from: 'coord',
        permissionMode: 'READ_ONLY',
        requestedModel: 'reported-model',
        timeoutMs: 60000
      },
      { orchestrationRequestId: 'idempotent-1' }
    )
    expect(JSON.stringify(call.mock.calls)).not.toMatch(/executablePath|codexHome|FULL_ACCESS/)
  })

  it('reads persistent state and bounded events through native RPC', async () => {
    call.mockResolvedValueOnce({
      result: { execution: { executionId: 'exec-1', status: 'COMPLETED', result: 'READY' } }
    })
    call.mockResolvedValueOnce({ result: { events: [{ sequence: 3, method: 'turn/completed' }] } })
    await invoke('orchestration codex-show', [['execution', 'exec-1']])
    await invoke('orchestration codex-events', [
      ['execution', 'exec-1'],
      ['after', '2']
    ])
    expect(call).toHaveBeenNthCalledWith(1, 'orchestration.codexShowV1', { executionId: 'exec-1' })
    expect(call).toHaveBeenNthCalledWith(2, 'orchestration.codexEventsV1', {
      executionId: 'exec-1',
      after: 2
    })
  })

  it('cancels only with a bound Run and coordinator handle', async () => {
    call.mockResolvedValue({ result: { execution: { executionId: 'exec-1', status: 'RUNNING' } } })
    await invoke('orchestration codex-cancel', [
      ['execution', 'exec-1'],
      ['run', 'run-1'],
      ['from', 'coord']
    ])
    expect(call).toHaveBeenCalledWith('orchestration.codexCancelV1', {
      executionId: 'exec-1',
      run: 'run-1',
      from: 'coord'
    })
  })

  it('does not submit a task without run authority', async () => {
    await expect(
      invoke('orchestration codex-start', [
        ['task', 'task-1'],
        ['from', 'coord']
      ])
    ).rejects.toThrow(/--run/)
    expect(call).not.toHaveBeenCalled()
  })
})
