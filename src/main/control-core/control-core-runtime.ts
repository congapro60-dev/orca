import type { CodexRuntimeRequest } from '../../shared/codex-runtime-contract'
import type {
  WorkItem,
  WorkContextCapsule,
  CoreRuntimeProfile
} from '../../shared/control-core-contract'
import type { CodexExecutionRecord } from '../runtime/orchestration/codex-execution-store'
import { redactString } from '../observability/redactor'
import type { ControlWorkStore } from './control-work-store'
import { compileWorkPacket } from './work-packet-compiler'
import {
  assertStartSource,
  prepareResume,
  releaseBlockedExecution,
  startSource
} from './resume-preparation'
import type { WorkspaceCheckpoint } from '../../shared/control-evidence-contract'
import { prepareResumeHandoff, handoffCapsule, completeResumeHandoff } from './resume-handoff'

export type CoreRuntimePort = {
  start: (
    taskId: string,
    request: CodexRuntimeRequest,
    signal?: AbortSignal,
    admittedCheckpoint?: WorkspaceCheckpoint,
    beforeDispatch?: () => Promise<void>
  ) => Promise<CodexExecutionRecord>
  get: (executionId: string) => CodexExecutionRecord
  result: (executionId: string) => Promise<CodexExecutionRecord>
  cancel: (executionId: string) => Promise<void>
}
export type CoreRuntimeEnvironment = {
  executablePath: string
  codexHome: string
  timeoutMs?: number
}

export class ControlCoreRuntime {
  private readonly starting = new Set<string>()
  private readonly preparing = new Map<string, AbortController>()

  constructor(
    private readonly store: ControlWorkStore,
    private readonly runtime: CoreRuntimePort,
    private readonly environment: CoreRuntimeEnvironment | (() => CoreRuntimeEnvironment)
  ) {}

  async start(
    id: string,
    expectedRevision: number,
    context: readonly WorkContextCapsule[],
    profile: CoreRuntimeProfile
  ): Promise<WorkItem> {
    const source = startSource(this.store, id, expectedRevision, profile.permissionMode)
    const admittedCheckpoint = source.item.executionId
      ? await prepareResume(this.store, source)
      : undefined
    const accepted = this.store.transaction(() => {
      const { item, session } = assertStartSource(this.store, source)
      releaseBlockedExecution(this.store, item.workItemId, admittedCheckpoint)
      const handoff = admittedCheckpoint
        ? prepareResumeHandoff(this.store, item, admittedCheckpoint)
        : null
      const packet = compileWorkPacket(
        session,
        item,
        handoff ? [handoffCapsule(handoff), ...context] : context,
        profile
      )
      const task = this.store.native.createTask({ spec: packet.prompt, runId: session.runId })
      this.store.native.db
        .prepare('INSERT INTO control_work_attempts (task_id,item_id,created_at) VALUES (?,?,?)')
        .run(task.id, item.workItemId, new Date().toISOString())
      const assigned = this.store.save({
        ...item,
        status: 'WAITING',
        assignedRuntime: 'codex',
        nativeTaskId: task.id,
        executionId: null,
        cancelRequested: false,
        evidenceRefs: [],
        artifactRefs: []
      })
      this.store.event(assigned, 'WORK_ASSIGNED', {
        runtime: 'codex',
        nativeTaskId: task.id,
        ...(handoff ? { handoffId: handoff.handoffId } : {}),
        selectedContextIds: packet.selectedContextIds,
        omittedContextIds: packet.omittedContextIds
      })
      return { item: assigned, session, packet }
    })
    this.starting.add(id)
    const controller = new AbortController()
    this.preparing.set(id, controller)
    try {
      const environment =
        typeof this.environment === 'function' ? this.environment() : this.environment
      const execution = await this.runtime.start(
        accepted.item.nativeTaskId!,
        {
          ...environment,
          worktree: accepted.session.worktree,
          prompt: accepted.packet.prompt,
          permissionMode: profile.permissionMode,
          approvalPolicy: 'never',
          ...(profile.requestedModel ? { requestedModel: profile.requestedModel } : {})
        },
        controller.signal,
        admittedCheckpoint
      )
      const attached = this.apply(id, execution)
      if (attached.cancelRequested && ['WAITING', 'RUNNING'].includes(attached.status)) {
        await this.runtime.cancel(execution.executionId)
        return this.refresh(id)
      }
      return attached
    } catch (error) {
      this.store.transaction(() => {
        const current = this.store.item(id)
        if (
          current.nativeTaskId !== accepted.item.nativeTaskId ||
          !['WAITING', 'RUNNING'].includes(current.status)
        ) {
          return
        }
        const task = this.store.native.getTask(current.nativeTaskId!)
        const provenUnstarted = task?.status === 'ready'
        if (provenUnstarted) {
          this.store.native.db
            .prepare(
              "UPDATE tasks SET status='failed',result=?,completed_at=? WHERE id=? AND status='ready'"
            )
            .run(
              current.cancelRequested
                ? 'Cancelled before dispatch'
                : 'Runtime preparation failed before dispatch',
              new Date().toISOString(),
              current.nativeTaskId
            )
        }
        const failed = this.store.save({
          ...current,
          // A refused replacement must not erase the source's continuity requirement.
          ...(provenUnstarted && source.item.executionId
            ? { nativeTaskId: source.item.nativeTaskId, executionId: source.item.executionId }
            : {}),
          status:
            current.cancelRequested && provenUnstarted
              ? 'CANCELLED'
              : provenUnstarted
                ? 'FAILED'
                : 'BLOCKED'
        })
        this.store.event(
          failed,
          failed.status === 'CANCELLED'
            ? 'WORK_CANCELLED'
            : provenUnstarted
              ? 'WORK_FAILED'
              : 'WORK_BLOCKED',
          {
            reason: redactString(error instanceof Error ? error.message : String(error)).slice(
              0,
              2000
            )
          }
        )
      })
      return this.store.item(id)
    } finally {
      this.starting.delete(id)
      this.preparing.delete(id)
    }
  }

  refresh(id: string): WorkItem {
    const item = this.store.item(id)
    if (['VERIFIED', 'READY_FOR_REVIEW', 'FAILED', 'CANCELLED'].includes(item.status)) {
      return item
    }
    let executionId = item.executionId
    if (!executionId && item.nativeTaskId) {
      // Native acceptance is durable even if the facade receipt was lost during restart.
      const row = this.store.native.db
        .prepare(`SELECT e.execution_id
        FROM codex_runtime_executions e JOIN dispatch_contexts d ON d.id=e.dispatch_id
        WHERE d.task_id=? AND d.run_id=?`)
        .get(item.nativeTaskId, this.store.session(item.logicalWorkSessionId).runId) as
        | { execution_id: string }
        | undefined
      executionId = row?.execution_id ?? null
    }
    if (executionId) {
      return this.apply(id, this.runtime.get(executionId))
    }
    if (item.status === 'WAITING' && !this.starting.has(id)) {
      return this.store.transaction(() => {
        const blocked = this.store.save({ ...item, status: 'BLOCKED' })
        this.store.event(blocked, 'WORK_BLOCKED', {
          reason: 'No durable execution receipt; reconcile before retry'
        })
        return blocked
      })
    }
    return item
  }

  async wait(id: string): Promise<WorkItem> {
    const item = this.store.item(id)
    if (!item.executionId) {
      throw new Error('WorkItem execution has not been linked')
    }
    return this.apply(id, await this.runtime.result(item.executionId))
  }

  async cancel(id: string): Promise<WorkItem> {
    let item = this.store.item(id)
    if (item.parentWorkItemId === null) {
      throw new Error('Cancel individual WorkItems; root completion belongs to Control Core')
    }
    if (!['QUEUED', 'WAITING', 'RUNNING'].includes(item.status)) {
      return item
    }
    item = this.store.transaction(() => {
      const current = this.store.item(id)
      const updated = this.store.save({
        ...current,
        cancelRequested: true,
        status: current.status === 'QUEUED' ? 'CANCELLED' : current.status
      })
      this.store.event(
        updated,
        updated.status === 'CANCELLED' ? 'WORK_CANCELLED' : 'WORK_PROGRESS',
        { cancelRequested: true }
      )
      return updated
    })
    if (item.executionId) {
      await this.runtime.cancel(item.executionId)
      return this.refresh(id)
    }
    this.preparing.get(id)?.abort()
    return item
  }

  private apply(id: string, execution: CodexExecutionRecord): WorkItem {
    return this.store.transaction(() => {
      const item = this.store.item(id)
      const session = this.store.session(item.logicalWorkSessionId)
      if (
        execution.taskId !== item.nativeTaskId ||
        execution.runId !== session.runId ||
        execution.worktree !== session.worktree ||
        (item.executionId && item.executionId !== execution.executionId)
      ) {
        throw new Error('Runtime receipt does not belong to canonical WorkItem attempt')
      }
      if (item.status === 'VERIFIED') {
        return item
      }
      const statuses = {
        STARTING: 'WAITING',
        RUNNING: 'RUNNING',
        COMPLETED: 'READY_FOR_REVIEW',
        FAILED: 'FAILED',
        CANCELLED: 'CANCELLED',
        OUTCOME_UNKNOWN: 'BLOCKED'
      } as const
      const status = statuses[execution.status]
      if (item.status === 'RUNNING' && status === 'WAITING') {
        return item
      }
      if (status === 'READY_FOR_REVIEW' && !execution.result?.trim()) {
        throw new Error('Completed execution has no result evidence')
      }
      if (item.status === status && item.executionId === execution.executionId) {
        return item
      }
      if (['READY_FOR_REVIEW', 'FAILED', 'CANCELLED'].includes(item.status)) {
        throw new Error('Runtime cannot replace settled WorkItem state')
      }
      const updated = this.store.save({
        ...item,
        status,
        executionId: execution.executionId,
        evidenceRefs:
          status === 'READY_FOR_REVIEW' ? [`execution:${execution.executionId}`] : item.evidenceRefs
      })
      this.store.native.db
        .prepare('UPDATE control_work_attempts SET execution_id=? WHERE task_id=?')
        .run(execution.executionId, item.nativeTaskId)
      completeResumeHandoff(this.store, updated)
      const types = {
        WAITING: 'WORK_PROGRESS',
        RUNNING: 'WORK_STARTED',
        READY_FOR_REVIEW: 'WORK_READY_FOR_REVIEW',
        FAILED: 'WORK_FAILED',
        CANCELLED: 'WORK_CANCELLED',
        BLOCKED: 'WORK_BLOCKED'
      } as const
      this.store.event(updated, types[status], {
        executionId: execution.executionId,
        runtimeStatus: execution.status
      })
      return updated
    })
  }
}
