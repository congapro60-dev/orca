import type { LogicalWorkSession, WorkEvent, WorkItem } from './control-core-contract'
import type { EvidenceRecord } from './control-evidence-contract'

export type DailyDriverWorkspace = {
  id: string
  projectId: string
  name: string
  path: string
  kind: 'git' | 'folder'
  head: string | null
  gitStatus: string | null
}

export type DailyDriverProject = {
  id: string
  name: string
  workspaces: DailyDriverWorkspace[]
}

export type DailyDriverSessionView = {
  session: LogicalWorkSession
  items: WorkItem[]
  events: WorkEvent[]
  result: string | null
  /** Runtime result per work item, so a conversation can render every answered turn. */
  itemResults: Record<string, string>
  executionId: string | null
  runtimeStatus: string | null
  runtimeError: string | null
  elapsedMs: number | null
  evidence: {
    executionId: string
    taskId: string
    dispatchId: string
    sandbox: string
    approval: string
    resultStored: boolean
  } | null
  reviewEvidence?: Pick<EvidenceRecord, 'contentHash' | 'commands' | 'observed'> | null
  recovery?: {
    status: 'RUNNING' | 'INTERRUPTED' | 'NEEDS_RECONCILE' | 'STALE_CHECKPOINT' | 'ELIGIBLE'
    processVerdict: 'live' | 'unverifiable' | 'exited'
    reason: string
  } | null
}

export type DailyDriverRequest =
  | { method: 'projects' }
  | { method: 'sessions'; projectId: string }
  | { method: 'workspaceInfo'; projectId: string; workspaceId: string }
  | {
      method: 'create'
      projectId: string
      workspaceId: string
      objective: string
      permissionMode?: 'READ_ONLY' | 'WORKSPACE_WRITE'
    }
  | { method: 'open'; sessionId: string }
  | {
      method: 'followup'
      sessionId: string
      objective: string
      permissionMode?: 'READ_ONLY' | 'WORKSPACE_WRITE'
    }
  | { method: 'start'; sessionId: string; expectedRevision: number }
  | { method: 'cancel'; sessionId: string }
  | { method: 'reconcile'; sessionId: string }
  | {
      method: 'verify'
      sessionId: string
      expectedRevision: number
      reviewedResultHash: string
      reviewedEvidenceHash?: string
      testCommandItemIds?: string[]
    }

export type DailyDriverResponse =
  | DailyDriverProject[]
  | DailyDriverWorkspace
  | LogicalWorkSession[]
  | DailyDriverSessionView
