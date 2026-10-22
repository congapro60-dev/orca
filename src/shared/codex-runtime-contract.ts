import type { CommandEvidence } from './control-evidence-contract'
import type { CodexProcessObservation } from './codex-process-contract'

export type CodexExecutionStatus =
  | 'STARTING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'OUTCOME_UNKNOWN'

export type CodexRuntimeRequest = {
  worktree: string
  prompt: string
  permissionMode: 'READ_ONLY' | 'WORKSPACE_WRITE'
  approvalPolicy: 'never'
  requestedModel?: string
  executablePath: string
  codexHome: string
  timeoutMs?: number
}

export type CodexRuntimeReceipt = {
  executionId: string
  requestedRuntime: 'codex'
  resolvedExecutablePath: string
  resolvedExecutableVersion: string
  runtimeProtocol: 'codex-app-server-jsonrpc-v2'
  requestedModel: string | null
  resolvedModel: string | null
  actualModel: 'UNKNOWN_UNVERIFIED'
  effectiveSandbox: 'READ_ONLY' | 'WORKSPACE_WRITE' | 'UNKNOWN_UNVERIFIED'
  approvalPolicy: 'never'
  worktree: string
  codexHome: string
  threadId: string | null
  turnId: string | null
}

export type CodexRuntimeEvent = {
  sequence: number
  at: string
  kind: 'STARTING' | 'RUNNING' | 'PROGRESS' | 'TERMINAL'
  method: string
  itemType?: string
}

export type CodexRuntimeResult = {
  status: CodexExecutionStatus
  receipt: CodexRuntimeReceipt
  text: string
  error: string | null
  /** Undefined/null means not captured; [] means an acknowledged turn had no captured commands. */
  commands?: CommandEvidence[] | null
  processObservations?: CodexProcessObservation[]
}
