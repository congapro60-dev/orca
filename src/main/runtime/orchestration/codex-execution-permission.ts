import type { CodexRuntimeReceipt } from '../../../shared/codex-runtime-contract'
import type { CodexExecutionRecord } from './codex-execution-store'
import type { OrchestrationDb } from './db'

export function assertCodexExecutionPermission(
  native: OrchestrationDb,
  record: CodexExecutionRecord,
  receipt: CodexRuntimeReceipt,
  runtimeEpoch: string
): 'READ_ONLY' | 'WORKSPACE_WRITE' {
  if (record.runtimeEpoch !== runtimeEpoch || record.worktree !== receipt.worktree) {
    throw new Error('Codex execution owner/workspace mismatch')
  }
  if (
    record.receipt &&
    (record.receipt.resolvedExecutablePath !== receipt.resolvedExecutablePath ||
      record.receipt.resolvedExecutableVersion !== receipt.resolvedExecutableVersion ||
      record.receipt.codexHome !== receipt.codexHome ||
      record.receipt.requestedRuntime !== receipt.requestedRuntime ||
      record.receipt.approvalPolicy !== receipt.approvalPolicy ||
      record.receipt.requestedModel !== receipt.requestedModel)
  ) {
    throw new Error('Codex executable, profile or request identity changed mid-execution')
  }
  const dispatch = native.getWorkerDispatch(record.dispatchId)
  const permission = dispatch ? JSON.parse(dispatch.start_options).permissionMode : null
  if (
    (permission !== 'READ_ONLY' && permission !== 'WORKSPACE_WRITE') ||
    receipt.approvalPolicy !== 'never' ||
    (receipt.effectiveSandbox !== 'UNKNOWN_UNVERIFIED' &&
      receipt.effectiveSandbox !== permission) ||
    (record.receipt &&
      record.receipt.effectiveSandbox !== 'UNKNOWN_UNVERIFIED' &&
      record.receipt.effectiveSandbox !== receipt.effectiveSandbox)
  ) {
    throw new Error('Codex sandbox differs from accepted dispatch permission')
  }
  return permission
}
