import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  DailyDriverProject,
  DailyDriverRequest,
  DailyDriverResponse,
  DailyDriverSessionView,
  DailyDriverWorkspace
} from '../../shared/daily-driver-contract'
import { resolveCodexRuntimeExecutable } from '../codex/codex-runtime-installation'
import { getOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getCodexExecutionSupervisor } from '../runtime/rpc/methods/orchestration-codex-execution'
import { ControlCoreFacade } from './control-core-facade'

const Id = z.string().trim().min(1).max(4096)
const Request = z.discriminatedUnion('method', [
  z.object({ method: z.literal('projects') }).strict(),
  z.object({ method: z.literal('sessions'), projectId: Id }).strict(),
  z.object({ method: z.literal('workspaceInfo'), projectId: Id, workspaceId: Id }).strict(),
  z
    .object({
      method: z.literal('create'),
      projectId: Id,
      workspaceId: Id,
      objective: z.string().trim().min(1).max(8000)
    })
    .strict(),
  z.object({ method: z.literal('open'), sessionId: z.string().uuid() }).strict(),
  z
    .object({
      method: z.literal('start'),
      sessionId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative()
    })
    .strict(),
  z.object({ method: z.literal('cancel'), sessionId: z.string().uuid() }).strict(),
  z
    .object({
      method: z.literal('verify'),
      sessionId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
      reviewedResultHash: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict()
])

/** Local desktop workflow boundary. The owning host resolves identity and runtime paths. */
export class DailyDriverHost {
  private facade: ControlCoreFacade | null = null
  private readonly reviewedResults = new Map<string, string>()

  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly resolveCodexHome: () => string = getOrcaManagedCodexHomePath
  ) {}

  private core(): ControlCoreFacade {
    if (!this.facade) {
      const native = this.runtime.getOrchestrationDb()
      this.facade = new ControlCoreFacade(
        native,
        {
          start: (taskId, request, signal) =>
            getCodexExecutionSupervisor(this.runtime).start(taskId, request, undefined, signal),
          get: (id) => getCodexExecutionSupervisor(this.runtime).get(id),
          result: (id) => getCodexExecutionSupervisor(this.runtime).result(id),
          cancel: (id) => getCodexExecutionSupervisor(this.runtime).cancel(id)
        },
        () => ({
          executablePath: resolveCodexRuntimeExecutable(),
          codexHome: this.resolveCodexHome()
        }),
        {
          verify: async ({ session, item, execution }) => {
            const task = native.getTask(item.nativeTaskId!)
            const dispatch = native.getWorkerDispatch(execution.dispatchId)
            const receipt = execution.receipt
            const acceptedHash = this.reviewedResults.get(item.workItemId)
            const actualHash = execution.result
              ? createHash('sha256').update(execution.result).digest('hex')
              : null
            const passed =
              execution.status === 'COMPLETED' &&
              execution.result?.trim() &&
              execution.runId === session.runId &&
              execution.taskId === item.nativeTaskId &&
              execution.worktree === session.worktree &&
              receipt?.effectiveSandbox === 'READ_ONLY' &&
              receipt.approvalPolicy === 'never' &&
              task?.status === 'completed' &&
              task.result === execution.result &&
              dispatch?.state === 'succeeded' &&
              acceptedHash !== undefined &&
              acceptedHash === actualHash
            return passed
              ? {
                  passed: true,
                  evidenceRefs: [
                    `execution:${execution.executionId}`,
                    `task:${task.id}`,
                    `dispatch:${dispatch.dispatch_id}`,
                    `user-reviewed:${acceptedHash}`
                  ]
                }
              : {
                  passed: false,
                  evidenceRefs: [],
                  reason: 'Native result, policy or dispatch evidence is incomplete'
                }
          }
        }
      )
    }
    return this.facade
  }

  private async projects(): Promise<DailyDriverProject[]> {
    const repos = this.runtime.listRepos()
    const worktrees = (await this.runtime.listManagedWorktrees(undefined, 1000)).worktrees
    return Promise.all(
      this.runtime.listProjects().map(async (project) => {
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
          const path = realpathSync(worktree.git.path)
          if (repo.kind === 'folder') {
            return {
              id: worktree.id,
              projectId: project.id,
              name: worktree.displayName,
              path,
              kind: 'folder',
              head: null,
              gitStatus: null
            }
          }
          return {
            id: worktree.id,
            projectId: project.id,
            name: worktree.displayName,
            path,
            kind: 'git',
            head: worktree.git.head ?? null,
            gitStatus: null
          }
        })
        return { id: project.id, name: project.displayName, workspaces }
      })
    )
  }

  private async workspaceInfo(
    projectId: string,
    workspaceId: string
  ): Promise<DailyDriverWorkspace> {
    const row = (await this.projects())
      .find((project) => project.id === projectId)
      ?.workspaces.find((workspace) => workspace.id === workspaceId)
    if (!row) {
      throw new Error('Choose a registered local workspace')
    }
    if (row.kind !== 'git') {
      return row
    }
    try {
      const [head, status] = await Promise.all([
        gitExecFileAsync(['rev-parse', 'HEAD'], {
          cwd: row.path,
          timeout: 10_000,
          maxBuffer: 65536
        }),
        gitExecFileAsync(['status', '--porcelain'], {
          cwd: row.path,
          timeout: 10_000,
          maxBuffer: 1_000_000
        })
      ])
      return { ...row, head: head.stdout.trim(), gitStatus: status.stdout.trim() ? 'dirty' : '' }
    } catch {
      return { ...row, head: null, gitStatus: null }
    }
  }

  private view(sessionId: string): DailyDriverSessionView {
    const state = this.core().openSession(sessionId)
    const item = state.items.find((row) => row.branchId === 'main')
    if (!item) {
      throw new Error('Logical session has no main WorkItem')
    }
    const native = this.runtime.getOrchestrationDb()
    const execution = item.executionId
      ? getCodexExecutionSupervisor(this.runtime).get(item.executionId)
      : null
    const task = item.nativeTaskId ? native.getTask(item.nativeTaskId) : null
    const dispatch = execution ? native.getWorkerDispatch(execution.dispatchId) : null
    return {
      ...state,
      result: execution?.result ?? null,
      executionId: execution?.executionId ?? null,
      runtimeStatus: execution?.status ?? null,
      runtimeError: execution?.error ?? null,
      elapsedMs:
        execution && task
          ? Math.max(0, Date.now() - Date.parse(`${task.created_at.replace(' ', 'T')}Z`))
          : null,
      evidence:
        execution && task && dispatch
          ? {
              executionId: execution.executionId,
              taskId: task.id,
              dispatchId: dispatch.dispatch_id,
              sandbox: execution.receipt?.effectiveSandbox ?? 'UNKNOWN_UNVERIFIED',
              approval: execution.receipt?.approvalPolicy ?? 'UNKNOWN_UNVERIFIED',
              resultStored: task.result === execution.result && execution.result !== null
            }
          : null
    }
  }

  async call(raw: DailyDriverRequest): Promise<DailyDriverResponse> {
    const request = Request.parse(raw)
    if (request.method === 'projects') {
      return this.projects()
    }
    if (request.method === 'sessions') {
      if (!this.runtime.listProjects().some((project) => project.id === request.projectId)) {
        throw new Error('Unknown registered project')
      }
      return this.core().listSessions(request.projectId)
    }
    if (request.method === 'workspaceInfo') {
      return this.workspaceInfo(request.projectId, request.workspaceId)
    }
    if (request.method === 'create') {
      const project = (await this.projects()).find((row) => row.id === request.projectId)
      const workspace = project?.workspaces.find((row) => row.id === request.workspaceId)
      if (!workspace) {
        throw new Error('Choose a registered local workspace')
      }
      const session = this.core().createSession({
        projectId: project!.id,
        worktree: workspace.path,
        objective: request.objective,
        doneWhen: ['Return a substantive result with native execution evidence'],
        constraints: ['Read-only inspection; do not change workspace files']
      })
      return this.view(session.logicalWorkSessionId)
    }
    const item = this.core()
      .openSession(request.sessionId)
      .items.find((row) => row.branchId === 'main')
    if (!item) {
      throw new Error('Logical session has no main WorkItem')
    }
    if (request.method === 'start') {
      const session = this.core().openSession(request.sessionId).session
      const projects = await this.projects()
      const current = projects
        .find((project) => project.id === session.projectId)
        ?.workspaces.some((workspace) => workspace.path === session.worktree)
      if (!current) {
        throw new Error('Registered local workspace changed; select a current workspace')
      }
      const pending = this.core().start(item.workItemId, request.expectedRevision)
      // Acceptance is durable before the runtime preflight returns; UI can now poll and cancel it.
      void pending.catch(() => {})
      if (this.core().item(item.workItemId).status !== 'WAITING') {
        await pending
      }
    }
    if (request.method === 'cancel') {
      await this.core().cancel(item.workItemId)
    }
    if (request.method === 'verify') {
      const latest = this.view(request.sessionId)
      const currentHash = latest.result
        ? createHash('sha256').update(latest.result).digest('hex')
        : null
      if (
        latest.items.find((row) => row.workItemId === item.workItemId)?.status !==
          'READY_FOR_REVIEW' ||
        currentHash !== request.reviewedResultHash
      ) {
        throw new Error('Result changed or is not ready; refresh and review it again')
      }
      this.reviewedResults.set(item.workItemId, request.reviewedResultHash)
      try {
        await this.core().verify(item.workItemId, request.expectedRevision)
      } finally {
        this.reviewedResults.delete(item.workItemId)
      }
    }
    return this.view(request.sessionId)
  }
}
