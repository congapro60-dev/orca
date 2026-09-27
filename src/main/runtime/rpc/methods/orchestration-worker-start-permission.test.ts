import { describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_WORKER_START_PERMISSION_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import { LegacyWorkerStartParams } from './orchestration-worker-start-schema'
import { WorkerStartWithPermissionParams } from './orchestration-worker-start-permission-schema'
import { ORCHESTRATION_WORKER_START_PERMISSION_METHODS } from './orchestration-worker-start-permission'

const method = ORCHESTRATION_WORKER_START_PERMISSION_METHODS[0]!
const base = { task: 'task_1', from: 'term_coord', agent: 'codex' }

function context(capabilities: readonly string[]) {
  const getOrchestrationDb = vi.fn()
  const validateOrchestrationReadOnlyCodexLauncher = vi.fn()
  return {
    getOrchestrationDb,
    validateOrchestrationReadOnlyCodexLauncher,
    rpc: {
      runtime: {
        getStatus: () => ({ capabilities }),
        getOrchestrationDb,
        validateOrchestrationReadOnlyCodexLauncher
      }
    } as never
  }
}

describe('workerStartWithPermissionV1 fail-closed contract', () => {
  it('does not advertise the unproven interactive permission path', () => {
    expect(RUNTIME_CAPABILITIES).not.toContain(
      ORCHESTRATION_WORKER_START_PERMISSION_RUNTIME_CAPABILITY
    )
  })

  it('rejects an explicit permission on legacy workerStart before Zod can strip it', () => {
    expect(
      LegacyWorkerStartParams.safeParse({ ...base, permissionMode: 'READ_ONLY' }).success
    ).toBe(false)
    expect(LegacyWorkerStartParams.safeParse(base).success).toBe(true)
  })

  it('requires a mode and rejects unknown values at the RPC schema boundary', () => {
    expect(WorkerStartWithPermissionParams.safeParse(base).success).toBe(false)
    expect(WorkerStartWithPermissionParams.safeParse({ ...base, permissionMode: 'UNKNOWN' }).success).toBe(false)
  })

  it('rejects a host without capability before DB or terminal creation', () => {
    const state = context([])
    expect(() =>
      method.handler({ ...base, permissionMode: 'READ_ONLY' }, state.rpc)
    ).toThrow(/unavailable/)
    expect(state.getOrchestrationDb).not.toHaveBeenCalled()
  })

  it('rejects READ_ONLY even if an old client supplies a stale capability', () => {
    const state = context([ORCHESTRATION_WORKER_START_PERMISSION_RUNTIME_CAPABILITY])
    expect(() => method.handler({ ...base, permissionMode: 'READ_ONLY' }, state.rpc)).toThrow(
      /unavailable/
    )
    expect(state.getOrchestrationDb).not.toHaveBeenCalled()
  })

  it.each(['WORKSPACE_WRITE', 'FULL_ACCESS'])(
    'rejects unsupported %s before DB or terminal creation',
    (permissionMode) => {
      const state = context([ORCHESTRATION_WORKER_START_PERMISSION_RUNTIME_CAPABILITY])
      expect(() => method.handler({ ...base, permissionMode }, state.rpc)).toThrow(
        /unavailable/
      )
      expect(state.getOrchestrationDb).not.toHaveBeenCalled()
    }
  )

  it.each([
    { on: 'remote' },
    { terminal: 'term_existing' },
    { worktree: 'new-child' },
    { worktree: 'path:C:/other' },
    { agent: 'claude' },
    { model: 'gpt-5.6-sol' },
    { effort: 'high' }
  ])('rejects unsupported placement or agent before side effects: %j', (placement) => {
    const state = context([ORCHESTRATION_WORKER_START_PERMISSION_RUNTIME_CAPABILITY])
    expect(() =>
      method.handler({ ...base, ...placement, permissionMode: 'READ_ONLY' }, state.rpc)
    ).toThrow(/unavailable/)
    expect(state.getOrchestrationDb).not.toHaveBeenCalled()
  })
})
