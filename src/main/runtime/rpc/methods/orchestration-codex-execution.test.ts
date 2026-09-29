import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_CODEX_EXECUTION_METHODS } from './orchestration-codex-execution'

const start = ORCHESTRATION_CODEX_EXECUTION_METHODS.find(
  (method) => method.name === 'orchestration.codexStartV1'
)!
const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function fixture() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const run = db.createRun({
    objective: 'Inspect',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'pane_coord'
  })
  const task = db.createTask({ spec: 'Inspect repo', runId: run.id })
  const runtime = {
    getOrchestrationDb: () => db,
    getTerminalPaneKey: (handle: string) => (handle === 'term_coord' ? 'pane_coord' : null),
    showTerminal: vi.fn(async () => ({ worktreeId: 'workspace_1' })),
    showManagedTerminalWorkspace: vi.fn(async () => ({
      repoId: 'repo_1',
      path: 'C:\\local\\repo'
    })),
    showRepo: vi.fn(async () => ({ id: 'repo_1', connectionId: 'remote' }))
  }
  const params = { task: task.id, run: run.id, from: 'term_coord', permissionMode: 'READ_ONLY' }
  return { db, run, task, runtime, params }
}

describe('programmatic Codex RPC authority boundary', () => {
  it('does not accept client-supplied executable, home, prompt, or FULL_ACCESS', () => {
    for (const extra of [
      { executablePath: 'malware.exe' },
      { codexHome: 'other-home' },
      { prompt: 'not canonical' },
      { permissionMode: 'FULL_ACCESS' }
    ]) {
      expect(start.params?.safeParse({ ...fixture().params, ...extra }).success).toBe(false)
    }
  })

  it('rejects a task outside the bound Run before workspace discovery or side effects', async () => {
    const state = fixture()
    const other = state.db.createRun({
      objective: 'other',
      coordinatorHandle: 'other',
      coordinatorPaneKey: 'other'
    })
    const task = state.db.createTask({ spec: 'not mine', runId: other.id })
    await expect(
      start.handler({ ...state.params, task: task.id }, { runtime: state.runtime } as never)
    ).rejects.toMatchObject({ code: 'task_not_startable' })
    expect(state.runtime.showTerminal).not.toHaveBeenCalled()
  })

  it('rejects a declared coordinator handle not bound to the Run', async () => {
    const state = fixture()
    await expect(
      start.handler({ ...state.params, from: 'stranger' }, { runtime: state.runtime } as never)
    ).rejects.toMatchObject({ code: expect.any(String) })
    expect(state.runtime.showTerminal).not.toHaveBeenCalled()
  })

  it('refuses remote repos before executable resolution or dispatch acceptance', async () => {
    const state = fixture()
    await expect(
      start.handler(state.params, { runtime: state.runtime } as never)
    ).rejects.toMatchObject({ code: 'invalid_placement' })
    expect(state.db.getTask(state.task.id)?.status).toBe('ready')
    expect(state.db.getDispatchContext(state.task.id)).toBeUndefined()
  })
})
