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
    expect(deps.supervisor.start).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        codexHome: 'owned-managed-account-home',
        permissionMode: 'READ_ONLY'
      }),
      undefined,
      expect.any(AbortSignal)
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
