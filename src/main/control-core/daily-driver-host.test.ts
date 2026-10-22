import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import type { DailyDriverSessionView } from '../../shared/daily-driver-contract'

const deps = vi.hoisted(() => ({
  supervisor: { start: vi.fn(), get: vi.fn(), result: vi.fn(), cancel: vi.fn() },
  resolveExecutable: vi.fn<() => string>(() => {
    throw new Error('No Codex installation in fixture')
  })
}))
vi.mock('../codex/codex-runtime-installation', () => ({
  resolveCodexRuntimeExecutable: deps.resolveExecutable
}))
vi.mock('../codex/codex-home-paths', () => ({ getOrcaManagedCodexHomePath: () => 'fixture-home' }))
vi.mock('../runtime/rpc/methods/orchestration-codex-execution', () => ({
  getCodexExecutionSupervisor: () => deps.supervisor
}))
import { DailyDriverHost } from './daily-driver-host'
import { ControlWorkStore } from './control-work-store'
import { ControlEvidenceStore } from './control-evidence-store'

const fixtures: { db: OrchestrationDb; dir: string }[] = []
afterEach(() => {
  for (const { db, dir } of fixtures.splice(0)) {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-daily-host-')))
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  fixtures.push({ db, dir })
  const local = {
    id: 'repo-local',
    path: dir,
    displayName: 'Local folder',
    kind: 'folder' as const
  }
  const remote = {
    id: 'repo-remote',
    path: dir,
    displayName: 'SSH repo',
    connectionId: 'ssh-1',
    executionHostId: 'ssh:ssh-1' as const
  }
  const project = {
    id: 'project-one',
    displayName: 'Project One',
    sourceRepoIds: [local.id, remote.id]
  }
  let localRegistered = true
  const runtime = {
    getOrchestrationDb: () => db,
    listRepos: () => (localRegistered ? [local, remote] : [remote]),
    listProjects: () => [project],
    listManagedWorktrees: async () => ({
      worktrees: [
        {
          id: 'workspace-local',
          repoId: local.id,
          projectId: project.id,
          displayName: 'Folder',
          git: { path: dir },
          hostId: 'local'
        },
        {
          id: 'workspace-remote',
          repoId: remote.id,
          projectId: project.id,
          displayName: 'Remote',
          git: { path: dir },
          hostId: 'ssh:ssh-1'
        }
      ],
      totalCount: 2,
      truncated: false
    })
  }
  return {
    dir,
    db,
    runtime,
    unregisterLocal: () => {
      localRegistered = false
    },
    host: new DailyDriverHost(runtime as never)
  }
}

describe('Daily Driver uses registered local workspace authority', () => {
  it('does not display a recovery decision belonging to a previous execution', async () => {
    const { host, db } = fixture()
    const created = (await host.call({
      method: 'create',
      projectId: 'project-one',
      workspaceId: 'workspace-local',
      objective: 'Inspect'
    })) as DailyDriverSessionView
    const item = created.items.find((row) => row.branchId === 'main')!
    new ControlEvidenceStore(new ControlWorkStore(db)).decision({
      workItemId: item.workItemId,
      sourceExecutionId: 'old-execution',
      status: 'ELIGIBLE',
      processVerdict: 'exited',
      baselineCheckpointId: null,
      observedCheckpointId: null,
      reason: 'Previous attempt only'
    })
    const view = (await host.call({
      method: 'open',
      sessionId: created.session.logicalWorkSessionId
    })) as DailyDriverSessionView
    expect(view.recovery).toBeNull()
  })

  it('reconciles locally without starting work; rejects caller authority and withdrawn registration', async () => {
    const f = fixture()
    const created = (await f.host.call({
      method: 'create',
      projectId: 'project-one',
      workspaceId: 'workspace-local',
      objective: 'Inspect'
    })) as DailyDriverSessionView
    const request = {
      method: 'reconcile' as const,
      sessionId: created.session.logicalWorkSessionId
    }
    const view = (await f.host.call(request)) as DailyDriverSessionView
    expect(view.recovery?.status).toBe('NEEDS_RECONCILE')
    expect(view.recovery?.processVerdict).toBe('unverifiable')
    const reopened = (await new DailyDriverHost(f.runtime as never).call({
      method: 'open',
      sessionId: created.session.logicalWorkSessionId
    })) as DailyDriverSessionView
    expect(reopened.recovery).toEqual(view.recovery)
    expect(deps.supervisor.start).not.toHaveBeenCalled()
    await expect(f.host.call({ ...request, processVerdict: 'exited' } as never)).rejects.toThrow()
    f.unregisterLocal()
    await expect(f.host.call(request)).rejects.toThrow(/Registered local workspace/)
  })
  it('uses the host-selected owned account home only when starting', async () => {
    const { runtime } = fixture()
    const resolveHome = vi.fn(() => 'owned-managed-account-home')
    const host = new DailyDriverHost(runtime as never, resolveHome)
    const created = (await host.call({
      method: 'create',
      projectId: 'project-one',
      workspaceId: 'workspace-local',
      objective: 'Inspect'
    })) as DailyDriverSessionView
    expect(resolveHome).not.toHaveBeenCalled()
    deps.resolveExecutable.mockReturnValueOnce('fixture-codex.exe')
    deps.supervisor.start.mockImplementationOnce(async () => {
      throw new Error('fixture preflight refusal')
    })
    await host.call({
      method: 'start',
      sessionId: created.session.logicalWorkSessionId,
      expectedRevision: created.items.find((item) => item.branchId === 'main')!.revision
    })
    await vi.waitFor(() => expect(deps.supervisor.start).toHaveBeenCalledTimes(1))
    expect(deps.supervisor.start).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        codexHome: 'owned-managed-account-home',
        permissionMode: 'READ_ONLY'
      }),
      undefined,
      expect.any(AbortSignal),
      expect.any(Function)
    )
  })

  it('persists WORKSPACE_WRITE permission in the logical session and runtime request', async () => {
    const { runtime } = fixture()
    const host = new DailyDriverHost(runtime as never)
    const created = (await host.call({
      method: 'create',
      projectId: 'project-one',
      workspaceId: 'workspace-local',
      objective: 'Make bounded change',
      permissionMode: 'WORKSPACE_WRITE'
    })) as DailyDriverSessionView
    expect(created.session.permissionMode).toBe('WORKSPACE_WRITE')
    const reopened = (await new DailyDriverHost(runtime as never).call({
      method: 'open',
      sessionId: created.session.logicalWorkSessionId
    })) as DailyDriverSessionView
    expect(reopened.session.permissionMode).toBe('WORKSPACE_WRITE')
    deps.resolveExecutable.mockReturnValueOnce('fixture-codex.exe')
    deps.supervisor.start.mockImplementationOnce(async () => {
      throw new Error('fixture preflight refusal')
    })
    await host.call({
      method: 'start',
      sessionId: created.session.logicalWorkSessionId,
      expectedRevision: created.items.find((item) => item.branchId === 'main')!.revision
    })
    await vi.waitFor(() => expect(deps.supervisor.start).toHaveBeenCalled())
    expect(deps.supervisor.start).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ permissionMode: 'WORKSPACE_WRITE' }),
      undefined,
      expect.any(AbortSignal),
      expect.any(Function)
    )
  })

  it('rechecks project/workspace ownership immediately before dispatch', async () => {
    const { host, db, unregisterLocal } = fixture()
    const created = (await host.call({
      method: 'create',
      projectId: 'project-one',
      workspaceId: 'workspace-local',
      objective: 'Inspect'
    })) as DailyDriverSessionView
    const item = created.items.find((work) => work.branchId === 'main')!
    unregisterLocal()
    await expect(
      host.call({
        method: 'start',
        sessionId: created.session.logicalWorkSessionId,
        expectedRevision: item.revision
      })
    ).rejects.toThrow(/registration changed|registered local workspace changed/i)
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n).toBe(0)
    expect(deps.supervisor.start).not.toHaveBeenCalled()
  })

  it('lists only local workspace and persists logical session without needing Codex installed', async () => {
    const { host, runtime, db, dir } = fixture()
    const projects = await host.call({ method: 'projects' })
    expect(projects).toMatchObject([
      { id: 'project-one', workspaces: [{ id: 'workspace-local', path: dir }] }
    ])
    expect(deps.resolveExecutable).not.toHaveBeenCalled()
    const created = (await host.call({
      method: 'create',
      projectId: 'project-one',
      workspaceId: 'workspace-local',
      objective: 'Read only inspection'
    })) as DailyDriverSessionView
    expect(created).toMatchObject({
      session: { projectId: 'project-one', status: 'ACTIVE' },
      items: [{ branchId: 'root' }, { branchId: 'main' }]
    })
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM control_work_sessions').get()?.n).toBe(1)
    const reopened = new DailyDriverHost(runtime as never)
    expect(await reopened.call({ method: 'sessions', projectId: 'project-one' })).toMatchObject([
      created.session
    ])
    expect(
      await reopened.call({ method: 'open', sessionId: created.session.logicalWorkSessionId })
    ).toMatchObject({ session: created.session })
  })

  it('rejects remote or forged project/workspace and permission fields before native Task creation', async () => {
    const { host, db } = fixture()
    await expect(
      host.call({
        method: 'create',
        projectId: 'project-one',
        workspaceId: 'workspace-remote',
        objective: 'Inspect'
      })
    ).rejects.toThrow(/registered local/)
    await expect(
      host.call({
        method: 'create',
        projectId: 'foreign',
        workspaceId: 'workspace-local',
        objective: 'Inspect'
      })
    ).rejects.toThrow(/registered local/)
    await expect(
      host.call({
        method: 'create',
        projectId: 'project-one',
        workspaceId: 'workspace-local',
        objective: 'Inspect',
        permissionMode: 'FULL_ACCESS'
      } as never)
    ).rejects.toThrow()
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM control_work_sessions').get()?.n).toBe(0)
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n).toBe(0)
  })
})

describe('Daily Driver follow-up continues the same logical session', () => {
  it('adds a conversation branch in the same session and dispatches it with the session permission', async () => {
    const { host, db } = fixture()
    const created = (await host.call({
      method: 'create',
      projectId: 'project-one',
      workspaceId: 'workspace-local',
      objective: 'First instruction'
    })) as DailyDriverSessionView
    const main = created.items.find((row) => row.branchId === 'main')!
    deps.resolveExecutable.mockReturnValueOnce('fixture-codex.exe')
    deps.supervisor.start.mockImplementationOnce(() => new Promise(() => {}))

    const view = (await host.call({
      method: 'followup',
      sessionId: created.session.logicalWorkSessionId,
      objective: 'Follow-up instruction'
    })) as DailyDriverSessionView

    expect(view.session.logicalWorkSessionId).toBe(created.session.logicalWorkSessionId)
    expect(view.items).toHaveLength(3)
    const followup = view.items.at(-1)!
    expect(followup.branchId).toMatch(/^conversation-/)
    expect(followup.objective).toBe('Follow-up instruction')
    expect(followup.parentWorkItemId).toBe(created.session.rootWorkItemId)
    expect(followup.workItemId).not.toBe(main.workItemId)
    await vi.waitFor(() => expect(deps.supervisor.start).toHaveBeenCalledTimes(1))
    expect(deps.supervisor.start).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ permissionMode: 'READ_ONLY' }),
      undefined,
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM control_work_sessions').get()?.n).toBe(1)
  })

  it('refuses a follow-up that tries to widen the persisted session permission', async () => {
    const { host } = fixture()
    const created = (await host.call({
      method: 'create',
      projectId: 'project-one',
      workspaceId: 'workspace-local',
      objective: 'Read only inspection'
    })) as DailyDriverSessionView
    await expect(
      host.call({
        method: 'followup',
        sessionId: created.session.logicalWorkSessionId,
        objective: 'Escalate',
        permissionMode: 'WORKSPACE_WRITE'
      })
    ).rejects.toThrow(/permission/i)
    expect(deps.supervisor.start).not.toHaveBeenCalled()
  })

  it('acts on the latest conversation branch instead of the original main item', async () => {
    const { host, db } = fixture()
    const created = (await host.call({
      method: 'create',
      projectId: 'project-one',
      workspaceId: 'workspace-local',
      objective: 'First instruction'
    })) as DailyDriverSessionView
    const main = created.items.find((row) => row.branchId === 'main')!
    deps.resolveExecutable.mockReturnValueOnce('fixture-codex.exe')
    deps.supervisor.start.mockImplementationOnce(() => new Promise(() => {}))
    const view = (await host.call({
      method: 'followup',
      sessionId: created.session.logicalWorkSessionId,
      objective: 'Follow-up instruction'
    })) as DailyDriverSessionView
    const followup = view.items.at(-1)!

    await host.call({
      method: 'cancel',
      sessionId: created.session.logicalWorkSessionId
    })

    const cancelled = db.db
      .prepare('SELECT cancel_requested AS n FROM control_work_items WHERE id=?')
      .get(followup.workItemId) as { n: number }
    const mainCancelled = db.db
      .prepare('SELECT cancel_requested AS n FROM control_work_items WHERE id=?')
      .get(main.workItemId) as { n: number }
    expect(cancelled.n).toBe(1)
    expect(mainCancelled.n).toBe(0)
  })
})
