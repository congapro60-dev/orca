import type { WorkItem } from '../../shared/control-core-contract'
import type { EvidenceRecord, WorkspaceCheckpoint } from '../../shared/control-evidence-contract'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { ControlWorkStore } from './control-work-store'
import { ControlEvidenceStore } from './control-evidence-store'
import { captureWorkspaceCheckpoint } from './workspace-checkpoint'
import { createHash } from 'node:crypto'
import type { DailyDriverRequest } from '../../shared/daily-driver-contract'
import type { CoreVerificationPort } from './control-core-verification'

export async function verifyDailyDriverResult(
  native: OrchestrationDb,
  { session, item, execution }: Parameters<CoreVerificationPort['verify']>[0],
  review: Extract<DailyDriverRequest, { method: 'verify' }> | undefined
): ReturnType<CoreVerificationPort['verify']> {
  const task = native.getTask(item.nativeTaskId!)
  const dispatch = native.getWorkerDispatch(execution.dispatchId)
  const receipt = execution.receipt
  if (
    session.permissionMode === 'WORKSPACE_WRITE' &&
    (!review?.reviewedEvidenceHash || !review.testCommandItemIds?.length)
  ) {
    throw new Error('Review evidence and select captured validation commands first')
  }
  await assertReviewedWorkspace(native, item, review?.reviewedEvidenceHash)
  const passed =
    execution.status === 'COMPLETED' &&
    execution.result?.trim() &&
    execution.runId === session.runId &&
    execution.taskId === item.nativeTaskId &&
    execution.worktree === session.worktree &&
    receipt?.effectiveSandbox === session.permissionMode &&
    (session.permissionMode === 'READ_ONLY'
      ? hasReadOnlyCheckpointEvidence(native, item)
      : hasWorkspaceWriteEvidence(native, item, review?.testCommandItemIds)) &&
    receipt.approvalPolicy === 'never' &&
    task?.status === 'completed' &&
    task.result === execution.result &&
    dispatch?.state === 'succeeded' &&
    review !== undefined &&
    review.reviewedResultHash === createHash('sha256').update(execution.result).digest('hex')
  return passed
    ? {
        passed: true,
        testCommandItemIds:
          session.permissionMode === 'WORKSPACE_WRITE' ? review.testCommandItemIds : undefined,
        evidenceRefs: [
          `execution:${execution.executionId}`,
          `task:${task.id}`,
          `dispatch:${dispatch.dispatch_id}`,
          `user-reviewed:${review.reviewedResultHash}`,
          ...(session.permissionMode === 'WORKSPACE_WRITE' ? ['owner-selected-runtime-tests'] : [])
        ]
      }
    : {
        passed: false,
        evidenceRefs: [],
        reason: 'Native result, policy or dispatch evidence is incomplete'
      }
}

export function latestExecutionEvidence(native: OrchestrationDb, item: WorkItem) {
  return new ControlEvidenceStore(new ControlWorkStore(native))
    .list(item.workItemId)
    .find((entry) => entry.executionId === item.executionId)
}

export function selectedTestEvidence(record: Pick<EvidenceRecord, 'commands'>, ids: string[]) {
  if (!ids.length || ids.length > 64 || new Set(ids).size !== ids.length) {
    throw new Error('Select distinct captured validation commands')
  }
  return ids.map((id) => {
    const matches = record.commands?.filter((command) => command.itemId === id) ?? []
    const command = matches[0]
    if (
      matches.length !== 1 ||
      command.status !== 'completed' ||
      command.exitCode !== 0 ||
      !command.command.trim() ||
      command.command.length >= 2048
    ) {
      throw new Error('Validation command is missing, incomplete or unsuccessful')
    }
    return { commandItemId: id, command: command.command, exitCode: command.exitCode }
  })
}

export async function assertReviewedWorkspace(
  native: OrchestrationDb,
  item: WorkItem,
  reviewedHash: string | undefined
): Promise<void> {
  const record = latestExecutionEvidence(native, item)
  if (!record?.observed || (reviewedHash && record.contentHash !== reviewedHash)) {
    throw new Error('Evidence changed or is unavailable; review it again')
  }
  const current = await captureWorkspaceCheckpoint(record.observed.worktree)
  if (current.workspaceHash !== record.observed.workspaceHash) {
    throw new Error('Workspace changed after result capture; verification is fenced')
  }
  if (latestExecutionEvidence(native, item)?.contentHash !== record.contentHash) {
    throw new Error('Evidence changed during verification; review it again')
  }
}

export function hasReadOnlyCheckpointEvidence(native: OrchestrationDb, item: WorkItem): boolean {
  const record = new ControlEvidenceStore(new ControlWorkStore(native))
    .list(item.workItemId)
    .find((entry) => entry.executionId === item.executionId)
  return (
    !!record &&
    record.verificationStatus === 'READY_FOR_REVIEW' &&
    !!record.baseline &&
    !!record.observed &&
    record.baseline.workspaceHash === record.observed.workspaceHash &&
    record.runtimeReceipt?.executionId === item.executionId
  )
}

export function hasWorkspaceWriteEvidence(
  native: OrchestrationDb,
  item: WorkItem,
  selectedIds?: string[]
): boolean {
  const record = new ControlEvidenceStore(new ControlWorkStore(native))
    .list(item.workItemId)
    .find((entry) => entry.executionId === item.executionId)
  const tests = record && selectedIds ? selectedTestEvidence(record, selectedIds) : record?.tests
  return (
    !!record &&
    record.verificationStatus === 'READY_FOR_REVIEW' &&
    record.runtimeReceipt?.executionId === item.executionId &&
    record.runtimeReceipt.effectiveSandbox === 'WORKSPACE_WRITE' &&
    record.runtimeReceipt.approvalPolicy === 'never' &&
    !!record.baseline &&
    !!record.observed &&
    record.baseline.worktree === record.observed.worktree &&
    record.runtimeReceipt.worktree === record.observed.worktree &&
    record.baseline.baselineCommit === record.observed.baselineCommit &&
    !!tests?.length &&
    new Set(tests.map((test) => test.commandItemId)).size === tests.length &&
    tests.every(
      (test) =>
        test.exitCode === 0 &&
        record.commands?.some(
          (command) =>
            command.itemId === test.commandItemId &&
            command.command === test.command &&
            command.status === 'completed' &&
            command.exitCode === 0
        )
    )
  )
}

/** Append the host decision in the same transaction as canonical verification; retain the old row. */
export function recordVerificationEvidence(
  work: ControlWorkStore,
  item: WorkItem,
  passed: boolean,
  refs: string[],
  testCommandItemIds?: string[]
): string | null {
  const store = new ControlEvidenceStore(work)
  const original = store
    .list(item.workItemId)
    .find((entry) => entry.executionId === item.executionId)
  if (!original) {
    // Legacy evidence was not captured; do not fabricate a historical snapshot.
    return null
  }
  const checkpoint = (id: string | undefined) => {
    if (!id) {
      return null
    }
    const row = work.native.db
      .prepare('SELECT snapshot FROM control_workspace_checkpoints WHERE id=? AND item_id=?')
      .get(id, item.workItemId) as { snapshot: string } | undefined
    if (!row) {
      throw new Error('Verification evidence checkpoint is unavailable')
    }
    return store.registeredCheckpoint(
      item.workItemId,
      JSON.parse(row.snapshot) as WorkspaceCheckpoint
    )
  }
  const { evidenceId: _id, contentHash: _hash, createdAt: _at, ...captured } = original
  return store.append({
    ...captured,
    tests:
      passed && testCommandItemIds
        ? selectedTestEvidence(original, testCommandItemIds)
        : original.tests,
    baseline: checkpoint(original.baseline?.checkpointId),
    observed: checkpoint(original.observed?.checkpointId),
    verificationStatus: passed ? 'VERIFIED' : 'REJECTED',
    sourceEvidenceRefs: [...new Set([`evidence:${original.evidenceId}`, ...refs])]
  }).evidenceId
}
