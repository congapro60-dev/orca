export type WorkStatus =
  | 'QUEUED'
  | 'WAITING'
  | 'RUNNING'
  | 'READY_FOR_REVIEW'
  | 'VERIFIED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED'
export type LogicalWorkSession = {
  logicalWorkSessionId: string
  projectId: string
  worktree: string
  objective: string
  permissionMode: 'READ_ONLY' | 'WORKSPACE_WRITE'
  status: 'ACTIVE' | 'COMPLETED' | 'BLOCKED' | 'CANCELLED'
  rootWorkItemId: string
  runId: string
  createdAt: string
  updatedAt: string
}
export type WorkItem = {
  workItemId: string
  logicalWorkSessionId: string
  parentWorkItemId: string | null
  branchId: string
  objective: string
  status: WorkStatus
  dependsOn: string[]
  assignedRuntime: 'codex' | null
  artifactRefs: string[]
  evidenceRefs: string[]
  doneWhen: string[]
  constraints: string[]
  nativeTaskId: string | null
  executionId: string | null
  cancelRequested: boolean
  revision: number
  createdAt: string
  updatedAt: string
}
export type WorkEventType =
  | 'WORK_CREATED'
  | 'WORK_ASSIGNED'
  | 'WORK_STARTED'
  | 'WORK_PROGRESS'
  | 'ARTIFACT_PUBLISHED'
  | 'WORK_READY_FOR_REVIEW'
  | 'WORK_VERIFIED'
  | 'WORK_FAILED'
  | 'WORK_BLOCKED'
  | 'WORK_CANCELLED'
  | 'BRANCH_CREATED'
  | 'MESSAGE_SENT'
  | 'JOIN_READY'
  | 'REPLAN_REQUESTED'
  | 'DECISION_RECORDED'
export type WorkEvent = {
  sequence: number
  logicalWorkSessionId: string
  workItemId: string
  type: WorkEventType
  payload: Record<string, unknown>
  createdAt: string
}
export type PeerMessageType =
  | 'QUESTION'
  | 'ANSWER'
  | 'PROGRESS'
  | 'RESULT'
  | 'BLOCKER'
  | 'REVIEW_REQUEST'
  | 'REVIEW_RESULT'
  | 'SPAWN_PROPOSAL'
  | 'HANDOFF'
export type PeerMessage = {
  messageId: string
  logicalWorkSessionId: string
  fromWorkItemId: string
  toWorkItemId: string
  type: PeerMessageType
  createdAt: string
  payload: Record<string, unknown>
  artifactRefs: string[]
  evidenceRefs: string[]
  requiresResponse: boolean
}
export type WorkContextCapsule = { id: string; content: string }
export type CoreRuntimeProfile = {
  runtime: 'codex'
  permissionMode: 'READ_ONLY' | 'WORKSPACE_WRITE'
  requestedModel?: string
}
