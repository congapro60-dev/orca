import type { LogicalWorkSession, WorkEvent, WorkItem } from './control-core-contract'

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
}

export type DailyDriverRequest =
  | { method: 'projects' }
  | { method: 'sessions'; projectId: string }
  | { method: 'workspaceInfo'; projectId: string; workspaceId: string }
  | { method: 'create'; projectId: string; workspaceId: string; objective: string }
  | { method: 'open'; sessionId: string }
  | { method: 'start'; sessionId: string; expectedRevision: number }
  | { method: 'cancel'; sessionId: string }
  | { method: 'verify'; sessionId: string; expectedRevision: number; reviewedResultHash: string }

export type DailyDriverResponse =
  | DailyDriverProject[]
  | DailyDriverWorkspace
  | LogicalWorkSession[]
  | DailyDriverSessionView
