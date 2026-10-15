import type { CodexRuntimeReceipt } from './codex-runtime-contract'

export type WorkspaceFileFingerprint = {
  path: string
  kind: 'file' | 'symlink'
  bytes: number
  sha256: string
}

export type WorkspaceCheckpoint = {
  checkpointId: string
  worktree: string
  kind: 'git' | 'folder'
  baselineCommit: string | null
  workspaceHash: string
  changedFiles: string[]
  diffHash: string | null
  files: WorkspaceFileFingerprint[]
  capturedAt: string
}

export type CommandEvidence = {
  itemId: string
  command: string
  exitCode: number | null
  status: string
}

export type EvidenceRecord = {
  evidenceId: string
  logicalWorkSessionId: string
  workItemId: string
  executionId: string | null
  baseline: Omit<WorkspaceCheckpoint, 'files'> | null
  observed: Omit<WorkspaceCheckpoint, 'files'> | null
  runtimeReceipt: CodexRuntimeReceipt | null
  commands: CommandEvidence[] | null
  tests: { commandItemId: string; command: string; exitCode: number | null }[] | null
  result: string | null
  verificationStatus: 'READY_FOR_REVIEW' | 'VERIFIED' | 'REJECTED' | 'UNVERIFIABLE'
  sourceEvidenceRefs: string[]
  contentHash: string
  createdAt: string
}

export type ResumeDecision = {
  decisionId: string
  workItemId: string
  sourceExecutionId: string | null
  status: 'RUNNING' | 'INTERRUPTED' | 'NEEDS_RECONCILE' | 'STALE_CHECKPOINT' | 'ELIGIBLE'
  processVerdict: 'live' | 'unverifiable' | 'exited'
  baselineCheckpointId: string | null
  observedCheckpointId: string | null
  reason: string
  createdAt: string
}

export type HandoffArtifactV0 = {
  handoffId: string
  logicalWorkSessionId: string
  workItemId: string
  objective: string
  acceptanceCriteria: string[]
  worktree: string
  baselineCommit: string | null
  workspaceHash: string
  changedFiles: string[]
  completedWork: string[]
  pendingWork: string[]
  constraints: string[]
  decisions: string[]
  tests: EvidenceRecord['tests']
  evidenceRefs: string[]
  sourceExecutionId: string | null
  targetExecutionId: string | null
  createdAt: string
}
