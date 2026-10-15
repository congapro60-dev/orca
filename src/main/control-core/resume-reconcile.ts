import type { ResumeDecision, WorkspaceCheckpoint } from '../../shared/control-evidence-contract'
import { ControlEvidenceStore } from './control-evidence-store'
import type { ControlWorkStore } from './control-work-store'
import { attemptCheckpoint } from './attempt-checkpoint'
import { readProcessObservations } from '../runtime/orchestration/codex-process-observation-store'

export type ReconcileInput = {
  workItemId: string
  sourceExecutionId: string | null
  observed: WorkspaceCheckpoint | null
}

/** Admission decision only. It never starts a replacement runtime. */
export function reconcileResume(work: ControlWorkStore, input: ReconcileInput): ResumeDecision {
  const store = new ControlEvidenceStore(work)
  const item = work.item(input.workItemId)
  const source = input.sourceExecutionId
  const attempt = source
    ? (work.native.db
        .prepare('SELECT item_id FROM control_work_attempts WHERE execution_id=?')
        .get(source) as { item_id: string } | undefined)
    : undefined
  const ownsSource = !!source && attempt?.item_id === item.workItemId && item.executionId === source
  const sourceStatus = ownsSource
    ? (
        work.native.db
          .prepare('SELECT status FROM codex_runtime_executions WHERE execution_id=?')
          .get(source) as { status: string } | undefined
      )?.status
    : undefined
  const baseline = ownsSource ? attemptCheckpoint(work, item.workItemId, source!) : null
  let processVerdict: ResumeDecision['processVerdict'] = 'unverifiable'
  if (ownsSource) {
    try {
      const observation = readProcessObservations(work.native, source!).at(-1)
      if (
        observation?.verdict === 'exited' &&
        observation.treeVerdict === 'exited' &&
        observation.scope === 'owned-process-launcher' &&
        observation.ownedTree
      ) {
        processVerdict = 'exited'
      }
    } catch {
      // Corrupt or historical process evidence never grants admission.
    }
  }
  let observed: WorkspaceCheckpoint | null = null
  let observedValid = input.observed === null
  if (input.observed) {
    try {
      observed = store.registeredCheckpoint(item.workItemId, input.observed)
      observedValid = true
    } catch {
      observedValid = false
    }
  }
  let status: ResumeDecision['status']
  let reason: string
  if (
    processVerdict === 'unverifiable' &&
    (sourceStatus === 'FAILED' || sourceStatus === 'CANCELLED')
  ) {
    status = 'INTERRUPTED'
    reason = 'Source execution ended without continuity proof; reconcile before replacement'
  } else if (processVerdict === 'unverifiable') {
    status = 'NEEDS_RECONCILE'
    reason = 'Host process liveness is unverifiable; replacement is fenced'
  } else if (!baseline || !observed || !observedValid) {
    status = 'NEEDS_RECONCILE'
    reason = 'A registered baseline and observed workspace checkpoint are required'
  } else if (baseline.workspaceHash !== observed.workspaceHash) {
    status = 'STALE_CHECKPOINT'
    reason = 'Workspace drifted from the registered checkpoint; replacement is fenced'
  } else {
    status = 'ELIGIBLE'
    reason = 'Workspace matches the registered checkpoint and source process exited'
  }
  return store.decision({
    workItemId: item.workItemId,
    sourceExecutionId: input.sourceExecutionId,
    status,
    processVerdict,
    baselineCheckpointId: baseline?.checkpointId ?? null,
    observedCheckpointId: observed?.checkpointId ?? input.observed?.checkpointId ?? null,
    reason
  })
}
