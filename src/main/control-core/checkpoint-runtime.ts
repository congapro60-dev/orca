import type { CoreRuntimePort } from './control-core-runtime'
import { ControlWorkStore } from './control-work-store'
import { ControlEvidenceStore } from './control-evidence-store'
import { captureWorkspaceCheckpoint } from './workspace-checkpoint'
import { bindAttemptCheckpoint, attemptCheckpoint } from './attempt-checkpoint'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { CodexExecutionRecord } from '../runtime/orchestration/codex-execution-store'
import type { WorkspaceCheckpoint } from '../../shared/control-evidence-contract'

/** Native host decorator: reserve in Core first, capture before dispatch, bind before return. */
export function checkpointRuntime(
  native: OrchestrationDb,
  runtime: CoreRuntimePort
): CoreRuntimePort {
  const work = new ControlWorkStore(native)
  const evidence = new ControlEvidenceStore(work)
  const pending = new Map<string, Promise<CodexExecutionRecord>>()
  const failures = new Map<string, Error>()
  const port: CoreRuntimePort = {
    ...runtime,
    get(id) {
      const failure = failures.get(id)
      if (failure) {
        throw failure
      }
      return runtime.get(id)
    },
    async start(taskId, request, signal, admittedCheckpoint) {
      const attempt = native.db
        .prepare('SELECT item_id FROM control_work_attempts WHERE task_id=?')
        .get(taskId) as { item_id: string } | undefined
      if (!attempt) {
        throw new Error('Native checkpoint requires a reserved Control Core attempt')
      }
      signal?.throwIfAborted()
      const checkpoint = evidence.checkpoint(
        attempt.item_id,
        await captureWorkspaceCheckpoint(request.worktree)
      )
      signal?.throwIfAborted()
      if (
        admittedCheckpoint &&
        evidence.registeredCheckpoint(attempt.item_id, admittedCheckpoint).workspaceHash !==
          checkpoint.workspaceHash
      ) {
        throw new Error('Workspace changed after resume admission; replacement is fenced')
      }
      const beforeDispatch = async () => {
        signal?.throwIfAborted()
        const current = await captureWorkspaceCheckpoint(request.worktree)
        signal?.throwIfAborted()
        if (current.workspaceHash !== checkpoint.workspaceHash) {
          throw new Error('Workspace changed during runtime preparation; replacement is fenced')
        }
      }
      const execution = await runtime.start(taskId, request, signal, undefined, beforeDispatch)
      if (execution.taskId !== taskId || execution.worktree !== checkpoint.worktree) {
        throw new Error('Checkpoint runtime returned foreign task or workspace')
      }
      bindAttemptCheckpoint(work, attempt.item_id, execution.executionId, checkpoint)
      // Core attaches the acknowledged attempt before the completion observer reads it.
      queueMicrotask(() => {
        void Promise.resolve()
          .then(() => port.result(execution.executionId))
          .catch((error) => {
            failures.set(
              execution.executionId,
              error instanceof Error ? error : new Error(String(error))
            )
          })
      })
      return execution
    },
    result(executionId) {
      const existing = pending.get(executionId)
      if (existing) {
        return existing
      }
      const result = capture(executionId).finally(() => pending.delete(executionId))
      pending.set(executionId, result)
      return result
    }
  }
  return port

  async function capture(executionId: string): Promise<CodexExecutionRecord> {
    const execution = await runtime.result(executionId)
    if (
      native.db
        .prepare('SELECT 1 FROM control_evidence_records WHERE execution_id=? LIMIT 1')
        .get(executionId)
    ) {
      return execution
    }
    const attempt = native.db
      .prepare('SELECT item_id FROM control_work_attempts WHERE execution_id=?')
      .get(executionId) as { item_id: string } | undefined
    const baseline = attempt ? attemptCheckpoint(work, attempt.item_id, executionId) : null
    if (!attempt || !baseline || ['STARTING', 'RUNNING'].includes(execution.status)) {
      throw new Error('Terminal evidence requires a native bound attempt and terminal result')
    }
    const session = work.session(work.item(attempt.item_id).logicalWorkSessionId)
    if (
      execution.executionId !== executionId ||
      execution.worktree !== baseline.worktree ||
      execution.runId !== session.runId
    ) {
      throw new Error('Terminal evidence runtime identity mismatch')
    }
    let observed: WorkspaceCheckpoint | null = null
    try {
      observed = await captureWorkspaceCheckpoint(execution.worktree)
    } catch {
      observed = null
    }
    if (observed) {
      evidence.checkpoint(attempt.item_id, observed)
    }
    evidence.append({
      logicalWorkSessionId: work.item(attempt.item_id).logicalWorkSessionId,
      workItemId: attempt.item_id,
      executionId,
      baseline,
      observed,
      runtimeReceipt: execution.receipt,
      commands: execution.commands ?? null,
      tests: null,
      result: execution.result,
      verificationStatus:
        execution.status === 'COMPLETED' && observed ? 'READY_FOR_REVIEW' : 'UNVERIFIABLE',
      sourceEvidenceRefs: []
    })
    return execution
  }
}
