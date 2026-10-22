import type { ControlWorkStore } from './control-work-store'
import { ControlEvidenceStore } from './control-evidence-store'
import { captureWorkspaceCheckpoint } from './workspace-checkpoint'
import { reconcileResume } from './resume-reconcile'
import type { WorkspaceCheckpoint } from '../../shared/control-evidence-contract'

export function startSource(
  work: ControlWorkStore,
  id: string,
  expectedRevision: number,
  requestedPermission?: string
) {
  const item = work.item(id)
  const session = work.session(item.logicalWorkSessionId)
  if (requestedPermission !== undefined && requestedPermission !== session.permissionMode) {
    throw new Error('Runtime permission differs from canonical session permission')
  }
  if (item.revision !== expectedRevision) {
    throw new Error('Stale WorkItem revision')
  }
  if (
    session.status !== 'ACTIVE' ||
    item.parentWorkItemId === null ||
    !['QUEUED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(item.status) ||
    (item.status === 'BLOCKED' && !item.executionId)
  ) {
    throw new Error('WorkItem cannot start from current state')
  }
  if (item.dependsOn.some((dep) => work.item(dep).status !== 'VERIFIED')) {
    throw new Error('WorkItem dependencies are not verified')
  }
  const blocker = work.native.db
    .prepare(
      "SELECT id,session_id,status FROM control_work_items WHERE status IN ('WAITING','RUNNING','BLOCKED') AND NOT (id=? AND status='BLOCKED') LIMIT 1"
    )
    .get(item.workItemId) as { id: string; session_id: string; status: string } | undefined
  if (blocker) {
    throw new Error(
      `Alpha runs only one WorkItem at a time; session ${blocker.session_id}, WorkItem ${blocker.id} is ${blocker.status}. Reconcile that work before starting another task.`
    )
  }
  return { item, session }
}

export function assertStartSource(work: ControlWorkStore, source: ReturnType<typeof startSource>) {
  const current = startSource(work, source.item.workItemId, source.item.revision)
  if (
    current.item.executionId !== source.item.executionId ||
    current.item.nativeTaskId !== source.item.nativeTaskId ||
    current.item.status !== source.item.status ||
    current.session.logicalWorkSessionId !== source.session.logicalWorkSessionId ||
    current.session.runId !== source.session.runId ||
    current.session.worktree !== source.session.worktree ||
    current.session.permissionMode !== source.session.permissionMode
  ) {
    throw new Error('WorkItem resume source identity changed')
  }
  return current
}

export async function prepareResume(
  work: ControlWorkStore,
  source: ReturnType<typeof startSource>
) {
  const captured = await captureWorkspaceCheckpoint(source.session.worktree)
  const { observed, decision } = work.transaction(() => {
    assertStartSource(work, source)
    const observed = new ControlEvidenceStore(work).checkpoint(source.item.workItemId, captured)
    const decision = reconcileResume(work, {
      workItemId: source.item.workItemId,
      sourceExecutionId: source.item.executionId,
      observed
    })
    return { observed, decision }
  })
  if (decision.status !== 'ELIGIBLE') {
    throw new Error(`WorkItem resume refused: ${decision.status}: ${decision.reason}`)
  }
  return observed
}

export function releaseBlockedExecution(
  work: ControlWorkStore,
  itemId: string,
  observed: WorkspaceCheckpoint | undefined
): void {
  if (!observed) {
    return
  }
  const item = work.item(itemId)
  const source = work.native.db
    .prepare(
      'SELECT status,recovery_decision_id FROM codex_runtime_executions WHERE execution_id=?'
    )
    .get(item.executionId) as { status: string; recovery_decision_id: string | null } | undefined
  if (source?.status !== 'OUTCOME_UNKNOWN') {
    return
  }
  const decision = reconcileResume(work, {
    workItemId: itemId,
    sourceExecutionId: item.executionId,
    observed
  })
  if (decision.status !== 'ELIGIBLE') {
    throw new Error(`WorkItem resume refused: ${decision.status}`)
  }
  if (!source.recovery_decision_id) {
    work.native.db
      .prepare(
        "UPDATE codex_runtime_executions SET recovery_decision_id=? WHERE execution_id=? AND status='OUTCOME_UNKNOWN' AND recovery_decision_id IS NULL"
      )
      .run(decision.decisionId, item.executionId)
    work.event(item, 'DECISION_RECORDED', {
      decision: 'Host-proven source exit permits a new attempt; previous outcome remains unknown',
      sourceExecutionId: item.executionId,
      recoveryDecisionId: decision.decisionId
    })
  }
}
