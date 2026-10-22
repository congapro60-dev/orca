import { realpathSync } from 'node:fs'
import type { DailyDriverProject, DailyDriverWorkspace } from '../../shared/daily-driver-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/** Local, non-remote workspaces the daily driver may dispatch work into. */
export async function listDailyDriverProjects(
  runtime: OrcaRuntimeService
): Promise<DailyDriverProject[]> {
  const repos = runtime.listRepos()
  const worktrees = (await runtime.listManagedWorktrees(undefined, 1000)).worktrees
  return Promise.all(
    runtime.listProjects().map(async (project) => {
      const eligible = worktrees.filter((worktree) => {
        const repo = repos.find((row) => row.id === worktree.repoId)
        return (
          repo &&
          project.sourceRepoIds.includes(repo.id) &&
          (!worktree.projectId || worktree.projectId === project.id) &&
          !repo.connectionId &&
          (!repo.executionHostId || repo.executionHostId === 'local') &&
          (!worktree.hostId || worktree.hostId === 'local')
        )
      })
      const workspaces: DailyDriverWorkspace[] = eligible.map((worktree) => {
        const repo = repos.find((row) => row.id === worktree.repoId)!
        const base = {
          id: worktree.id,
          projectId: project.id,
          name: worktree.displayName,
          path: realpathSync(worktree.git.path)
        }
        if (repo.kind === 'folder') {
          return { ...base, kind: 'folder', head: null, gitStatus: null }
        }
        return { ...base, kind: 'git', head: worktree.git.head ?? null, gitStatus: null }
      })
      return { id: project.id, name: project.displayName, workspaces }
    })
  )
}
