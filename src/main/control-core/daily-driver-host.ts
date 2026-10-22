import { createHash } from 'node:crypto'
import type {
  DailyDriverProject,
  DailyDriverRequest,
  DailyDriverResponse,
  DailyDriverSessionView,
  DailyDriverWorkspace
} from '../../shared/daily-driver-contract'
import type { LogicalWorkSession, WorkItem } from '../../shared/control-core-contract'
import { resolveCodexRuntimeExecutable } from '../codex/codex-runtime-installation'
import { getOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getCodexExecutionSupervisor } from '../runtime/rpc/methods/orchestration-codex-execution'
import { ControlCoreFacade } from './control-core-facade'
import type { CoreVerificationPort } from './control-core-verification'
import { checkpointRuntime } from './checkpoint-runtime'
import { collectItemResults } from './daily-driver-item-results'
import { listDailyDriverProjects } from './daily-driver-projects'
import { reconcileDailyDriver } from './daily-driver-reconcile'
import { DailyDriverRequestSchema } from './daily-driver-request'
import { latestExecutionEvidence, verifyDailyDriverResult } from './verification-evidence'

const DONE_WHEN = ['Return a substantive result with native execution evidence']
type PermissionMode = 'READ_ONLY' | 'WORKSPACE_WRITE'

/** Local desktop workflow boundary. The owning host resolves identity and runtime paths. */
export class DailyDriverHost {
  private facade: ControlCoreFacade | null = null
  private readonly reviewedResults = new Map<
    string,
    Extract<DailyDriverRequest, { method: 'verify' }>
  >()

  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly resolveCodexHome: () => string = getOrcaManagedCodexHomePath
  ) {}

  private supervisor(): ReturnType<typeof getCodexExecutionSupervisor> {
    return getCodexExecutionSupervisor(this.runtime)
  }

  private core(): ControlCoreFacade {
    if (!this.facade) {
      const native = this.runtime.getOrchestrationDb()
      const checkpoint = checkpointRuntime(native, {
        start: (taskId, request, signal, _checkpoint, beforeDispatch) =>
          this.supervisor().start(taskId, request, undefined, signal, beforeDispatch),
        get: (id) => this.supervisor().get(id),
        result: (id) => this.supervisor().result(id),
        cancel: (id) => this.supervisor().cancel(id)
      })
      const environment = () => ({
        executablePath: resolveCodexRuntimeExecutable(),
        codexHome: this.resolveCodexHome()
      })
      const evidence = {
        verify: (input: Parameters<CoreVerificationPort['verify']>[0]) =>
          verifyDailyDriverResult(native, input, this.reviewedResults.get(input.item.workItemId))
      }
      this.facade = new ControlCoreFacade(native, checkpoint, environment, evidence)
    }
    return this.facade
  }

  private listProjects(): Promise<DailyDriverProject[]> {
    return listDailyDriverProjects(this.runtime)
  }

  private async workspaceInfo(
    projectId: string,
    workspaceId: string
  ): Promise<DailyDriverWorkspace> {
    const row = (await this.listProjects())
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

  private currentItem(items: WorkItem[]): WorkItem {
    const item = items.toReversed().find((row) => row.branchId !== 'root')
    if (!item) {
      throw new Error('Logical session has no work item')
    }
    return item
  }

  private view(sessionId: string): DailyDriverSessionView {
    const state = this.core().openSession(sessionId)
    const item = this.currentItem(state.items)
    const native = this.runtime.getOrchestrationDb()
    const execution = item.executionId ? this.supervisor().get(item.executionId) : null
    const task = item.nativeTaskId ? native.getTask(item.nativeTaskId) : null
    const dispatch = execution ? native.getWorkerDispatch(execution.dispatchId) : null
    const record = latestExecutionEvidence(native, item)
    const decision = this.core().latestDecision(item.workItemId)
    const recovery =
      decision && decision.sourceExecutionId === item.executionId
        ? {
            status: decision.status,
            processVerdict: decision.processVerdict,
            reason: decision.reason
          }
        : null
    const evidence =
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
    return {
      ...state,
      result: execution?.result ?? null,
      itemResults: collectItemResults(this.supervisor(), state.items),
      executionId: execution?.executionId ?? null,
      runtimeStatus: execution?.status ?? null,
      runtimeError: execution?.error ?? null,
      reviewEvidence: record
        ? { contentHash: record.contentHash, commands: record.commands, observed: record.observed }
        : null,
      elapsedMs:
        execution && task
          ? Math.max(0, Date.now() - Date.parse(`${task.created_at.replace(' ', 'T')}Z`))
          : null,
      evidence,
      recovery
    }
  }

  private assertRegisteredWorkspace(
    projects: DailyDriverProject[],
    session: LogicalWorkSession
  ): void {
    const current = projects
      .find((project) => project.id === session.projectId)
      ?.workspaces.some((workspace) => workspace.path === session.worktree)
    if (!current) {
      throw new Error('Registered local workspace changed; select a current workspace')
    }
  }

  private async createSession(
    request: Extract<DailyDriverRequest, { method: 'create' }>
  ): Promise<DailyDriverSessionView> {
    const workspace = (await this.listProjects())
      .find((row) => row.id === request.projectId)
      ?.workspaces.find((row) => row.id === request.workspaceId)
    if (!workspace) {
      throw new Error('Choose a registered local workspace')
    }
    const session = this.core().createSession({
      projectId: request.projectId,
      worktree: workspace.path,
      objective: request.objective,
      doneWhen: DONE_WHEN,
      constraints: [
        request.permissionMode === 'WORKSPACE_WRITE'
          ? 'Workspace-scoped write only; do not access credentials or global config'
          : 'Read-only inspection; do not change workspace files'
      ],
      permissionMode: request.permissionMode ?? 'READ_ONLY'
    })
    return this.view(session.logicalWorkSessionId)
  }

  /** Durable acceptance before the runtime preflight returns; the UI can poll and cancel it. */
  private async dispatch(
    workItemId: string,
    expectedRevision: number,
    permissionMode?: PermissionMode
  ): Promise<void> {
    const pending = permissionMode
      ? this.core().start(workItemId, expectedRevision, [], { runtime: 'codex', permissionMode })
      : this.core().start(workItemId, expectedRevision)
    void pending.catch(() => {})
    if (this.core().item(workItemId).status !== 'WAITING') {
      await pending
    }
  }

  /** A follow-up is a new conversation turn in the same logical session, never a new authority. */
  private async followup(
    request: Extract<DailyDriverRequest, { method: 'followup' }>
  ): Promise<DailyDriverSessionView> {
    const { session } = this.core().openSession(request.sessionId)
    if (request.permissionMode && request.permissionMode !== session.permissionMode) {
      throw new Error('Follow-up permission must match the logical session permission')
    }
    const followup = this.core().addFollowup(request.sessionId, {
      objective: request.objective,
      branchId: `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      doneWhen: DONE_WHEN,
      constraints: [
        session.permissionMode === 'WORKSPACE_WRITE'
          ? 'Write only inside the registered workspace; preserve Control Core evidence gates'
          : 'Do not write files'
      ]
    })
    await this.dispatch(followup.workItemId, followup.revision, session.permissionMode)
    return this.view(request.sessionId)
  }

  /** Verification needs a human review of exactly the displayed result hash. */
  private async verify(
    request: Extract<DailyDriverRequest, { method: 'verify' }>,
    item: WorkItem
  ): Promise<void> {
    const latest = this.view(request.sessionId)
    const currentHash = latest.result
      ? createHash('sha256').update(latest.result).digest('hex')
      : null
    const ready = latest.items.find((row) => row.workItemId === item.workItemId)?.status
    if (ready !== 'READY_FOR_REVIEW' || currentHash !== request.reviewedResultHash) {
      throw new Error('Result changed or is not ready; refresh and review it again')
    }
    if (this.reviewedResults.has(item.workItemId)) {
      throw new Error('Verification is already in progress')
    }
    this.reviewedResults.set(item.workItemId, request)
    try {
      await this.core().verify(item.workItemId, request.expectedRevision)
    } finally {
      this.reviewedResults.delete(item.workItemId)
    }
  }

  async call(raw: DailyDriverRequest): Promise<DailyDriverResponse> {
    const request = DailyDriverRequestSchema.parse(raw)
    if (request.method === 'projects') {
      return this.listProjects()
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
      return this.createSession(request)
    }
    const { session, items } = this.core().openSession(request.sessionId)
    const item = this.currentItem(items)
    if (['start', 'reconcile', 'followup'].includes(request.method)) {
      this.assertRegisteredWorkspace(await this.listProjects(), session)
    }
    if (request.method === 'followup') {
      return this.followup(request)
    }
    if (request.method === 'start') {
      await this.dispatch(item.workItemId, request.expectedRevision)
    }
    if (request.method === 'cancel') {
      await this.core().cancel(item.workItemId)
    }
    if (request.method === 'reconcile') {
      const core = this.core()
      await reconcileDailyDriver(
        core,
        this.runtime.getOrchestrationDb(),
        item.workItemId,
        request.sessionId
      )
    }
    if (request.method === 'verify') {
      await this.verify(request, item)
    }
    return this.view(request.sessionId)
  }
}
