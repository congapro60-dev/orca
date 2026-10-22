import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  LogicalWorkSession,
  WorkItem,
  WorkEvent,
  WorkEventType
} from '../../shared/control-core-contract'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { createRunInTransaction } from '../runtime/orchestration/db/runs/run-create'
import { redactValue } from '../observability/redactor'

const Text = z.string().trim().min(1).max(8000)
const Refs = z.array(z.string().min(1).max(1000)).max(64)
const ItemInput = z
  .object({
    objective: Text,
    branchId: z.string().min(1).max(128),
    dependsOn: Refs.default([]),
    doneWhen: Refs.default([]),
    constraints: Refs.default([])
  })
  .strict()
export type NewWorkItem = z.input<typeof ItemInput>

export class ControlWorkStore {
  constructor(readonly native: OrchestrationDb) {}

  transaction<T>(body: () => T): T {
    this.native.db.exec('SAVEPOINT control_core')
    try {
      const result = body()
      this.native.db.exec('RELEASE control_core')
      return result
    } catch (error) {
      this.native.db.exec('ROLLBACK TO control_core; RELEASE control_core')
      throw error
    }
  }

  create(
    projectId: string,
    worktree: string,
    objective: string,
    criteria: {
      doneWhen?: string[]
      constraints?: string[]
      permissionMode?: 'READ_ONLY' | 'WORKSPACE_WRITE'
    } = {}
  ): LogicalWorkSession {
    const input = z
      .object({
        projectId: z.string().min(1).max(512),
        worktree: z.string().min(1).max(4096),
        objective: Text
      })
      .parse({ projectId, worktree, objective })
    const permissionMode = z
      .enum(['READ_ONLY', 'WORKSPACE_WRITE'])
      .parse(criteria.permissionMode ?? 'READ_ONLY')
    return this.transaction(() => {
      const { permissionMode: _permissionMode, ...itemCriteria } = criteria
      const id = randomUUID()
      const rootId = randomUUID()
      const now = new Date().toISOString()
      const run = createRunInTransaction.call(this.native, {
        objective: input.objective,
        coordinatorHandle: `control-core:${id}`,
        coordinatorPaneKey: `control-core:${id}`
      })
      this.native.db
        .prepare(`INSERT INTO control_work_sessions
        (id,project_id,worktree,objective,status,root_id,run_id,created_at,updated_at)
        VALUES (?,?,?,?,'ACTIVE',?,?,?,?)`)
        .run(id, input.projectId, input.worktree, input.objective, rootId, run.id, now, now)
      this.native.db
        .prepare(
          'INSERT INTO control_work_session_profiles (session_id,permission_mode) VALUES (?,?)'
        )
        .run(id, permissionMode)
      this.insertItem(id, rootId, null, { objective: input.objective, branchId: 'root' })
      this.addItem(id, rootId, { objective: input.objective, branchId: 'main', ...itemCriteria })
      return this.session(id)
    })
  }

  addItem(sessionId: string, parentId: string, input: NewWorkItem): WorkItem {
    const parsed = ItemInput.parse(input)
    return this.transaction(() => {
      const session = this.session(sessionId)
      const parent = this.item(parentId)
      if (
        !['ACTIVE', 'COMPLETED'].includes(session.status) ||
        parent.logicalWorkSessionId !== sessionId ||
        parent.status === 'VERIFIED'
      ) {
        throw new Error('WorkGraph is closed or parent belongs to another session')
      }
      if (parentId !== session.rootWorkItemId) {
        throw new Error('Recursive decomposition is not enabled in Alpha')
      }
      if (this.items(sessionId).length >= 64) {
        throw new Error('WorkGraph node limit reached')
      }
      for (const dependency of parsed.dependsOn) {
        if (
          this.item(dependency).logicalWorkSessionId !== sessionId ||
          dependency === session.rootWorkItemId
        ) {
          throw new Error(
            'WorkGraph dependency must be an existing non-root item in the same session'
          )
        }
      }
      const item = this.insertItem(sessionId, randomUUID(), parentId, parsed)
      this.event(item, 'BRANCH_CREATED', { branchId: item.branchId })
      return item
    })
  }

  private insertItem(
    sessionId: string,
    id: string,
    parentId: string | null,
    input: NewWorkItem
  ): WorkItem {
    const value = ItemInput.parse(input)
    const now = new Date().toISOString()
    this.native.db
      .prepare(`INSERT INTO control_work_items
      (id,session_id,parent_id,branch_id,objective,status,depends_on,done_when,constraints_json,created_at,updated_at)
      VALUES (?,?,?,?,?,'QUEUED',?,?,?,?,?)`)
      .run(
        id,
        sessionId,
        parentId,
        value.branchId,
        value.objective,
        JSON.stringify(value.dependsOn),
        JSON.stringify(value.doneWhen),
        JSON.stringify(value.constraints),
        now,
        now
      )
    const item = this.item(id)
    this.event(item, 'WORK_CREATED', {})
    return item
  }

  session(id: string): LogicalWorkSession {
    const row = this.native.db
      .prepare(`SELECT id AS logicalWorkSessionId,project_id AS projectId,worktree,objective,status,
      root_id AS rootWorkItemId,run_id AS runId,created_at AS createdAt,updated_at AS updatedAt,
      COALESCE(control_work_session_profiles.permission_mode,'READ_ONLY') AS permissionMode
      FROM control_work_sessions
      LEFT JOIN control_work_session_profiles ON control_work_session_profiles.session_id=control_work_sessions.id
      WHERE id=?`)
      .get(id) as LogicalWorkSession | undefined
    if (!row) {
      throw new Error('Unknown logical work session')
    }
    z.enum(['READ_ONLY', 'WORKSPACE_WRITE']).parse(row.permissionMode)
    return row
  }

  sessions(projectId: string): LogicalWorkSession[] {
    const rows = this.native.db
      .prepare(
        'SELECT id FROM control_work_sessions WHERE project_id=? ORDER BY updated_at DESC LIMIT 100'
      )
      .all(projectId) as { id: string }[]
    return rows.map((row) => this.session(row.id))
  }

  item(id: string): WorkItem {
    const row = this.native.db
      .prepare(`SELECT id AS workItemId,session_id AS logicalWorkSessionId,parent_id AS parentWorkItemId,
      branch_id AS branchId,objective,status,depends_on AS dependsOn,runtime AS assignedRuntime,artifacts AS artifactRefs,
      evidence AS evidenceRefs,done_when AS doneWhen,constraints_json AS constraints,native_task_id AS nativeTaskId,
      execution_id AS executionId,cancel_requested AS cancelRequested,revision,created_at AS createdAt,updated_at AS updatedAt FROM control_work_items WHERE id=?`)
      .get(id) as Record<string, unknown> | undefined
    if (!row) {
      throw new Error('Unknown WorkItem')
    }
    for (const key of ['dependsOn', 'artifactRefs', 'evidenceRefs', 'doneWhen', 'constraints']) {
      row[key] = Refs.parse(JSON.parse(row[key] as string))
    }
    row.cancelRequested = row.cancelRequested === 1
    return row as WorkItem
  }

  items(sessionId: string): WorkItem[] {
    this.session(sessionId)
    const rows = this.native.db
      .prepare('SELECT id FROM control_work_items WHERE session_id=? ORDER BY rowid')
      .all(sessionId) as { id: string }[]
    return rows.map((row) => this.item(row.id))
  }

  save(item: WorkItem): WorkItem {
    const now = new Date().toISOString()
    const update = this.native.db
      .prepare(`UPDATE control_work_items SET status=?,runtime=?,artifacts=?,evidence=?,
      native_task_id=?,execution_id=?,cancel_requested=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?`)
      .run(
        item.status,
        item.assignedRuntime,
        JSON.stringify(Refs.parse(item.artifactRefs)),
        JSON.stringify(Refs.parse(item.evidenceRefs)),
        item.nativeTaskId,
        item.executionId,
        item.cancelRequested ? 1 : 0,
        now,
        item.workItemId,
        item.revision
      )
    if (update.changes !== 1) {
      throw new Error('Stale WorkItem revision')
    }
    this.native.db
      .prepare('UPDATE control_work_sessions SET updated_at=? WHERE id=?')
      .run(now, item.logicalWorkSessionId)
    return this.item(item.workItemId)
  }

  event(item: WorkItem, type: WorkEventType, payload: Record<string, unknown>): void {
    const json = JSON.stringify(redactValue(payload))
    if (json.length > 16000) {
      throw new Error('Work event payload exceeds limit')
    }
    this.native.db
      .prepare(
        `INSERT INTO control_work_events (session_id,item_id,type,payload,created_at) VALUES (?,?,?,?,?)`
      )
      .run(item.logicalWorkSessionId, item.workItemId, type, json, new Date().toISOString())
  }

  events(sessionId: string, after = 0): WorkEvent[] {
    const rows = this.native.db
      .prepare(`SELECT sequence,session_id AS logicalWorkSessionId,item_id AS workItemId,
      type,payload,created_at AS createdAt FROM control_work_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 500`)
      .all(sessionId, after) as (Omit<WorkEvent, 'payload'> & { payload: string })[]
    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload) as Record<string, unknown>
    }))
  }
}
