import type {
  CodexRuntimeEvent,
  CodexRuntimeReceipt,
  CodexRuntimeResult,
  CodexExecutionStatus
} from '../../../shared/codex-runtime-contract'
import { redactString } from '../../observability/redactor'
import type { OrchestrationDb } from './db'
import {
  failWorkerStartInTransaction,
  markWorkerDispatchReadyInTransaction
} from './db/worker-dispatch/worker-dispatch-outcome'

export type CodexExecutionRecord = {
  executionId: string
  dispatchId: string
  taskId: string
  runId: string
  worktree: string
  runtimeEpoch: string
  status: CodexExecutionStatus
  receipt: CodexRuntimeReceipt | null
  result: string | null
  error: string | null
}

type ExecutionRow = {
  execution_id: string
  dispatch_id: string
  task_id: string
  run_id: string
  worktree: string
  runtime_epoch: string
  status: CodexExecutionStatus
  receipt_json: string | null
  result: string | null
  error: string | null
}
const ACTIVE = new Set<CodexExecutionStatus>(['STARTING', 'RUNNING'])

/** Uses the existing native connection and Task.result; never a parallel Task store. */
export class CodexExecutionStore {
  constructor(
    private readonly native: OrchestrationDb,
    readonly runtimeEpoch: string
  ) {
    if (!runtimeEpoch) {
      throw new Error('Runtime epoch is required')
    }
  }

  accept(
    taskId: string,
    executionId: string,
    worktree: string,
    mutationReceipt?: {
      callerFingerprint: string
      requestId: string
      method: string
      payloadHash: string
    }
  ): CodexExecutionRecord {
    this.native.createStartingWorkerDispatch({
      taskId,
      runtimeEpoch: this.runtimeEpoch,
      creator: { kind: 'system' },
      maxDepth: 1,
      startOptions: {
        runtime: 'codex-app-server',
        permissionMode: 'READ_ONLY',
        executionId,
        worktree
      },
      codexExecution: { executionId, worktree },
      mutationReceipt
    })
    return this.require(executionId)
  }

  require(id: string): CodexExecutionRecord {
    const row = this.native.db
      .prepare(`SELECT e.*, d.task_id, d.run_id, r.result
      FROM codex_runtime_executions e JOIN dispatch_contexts d ON d.id = e.dispatch_id
      LEFT JOIN codex_runtime_results r ON r.execution_id = e.execution_id WHERE e.execution_id = ?`)
      .get(id) as ExecutionRow | undefined
    if (!row) {
      throw new Error('Unknown native Codex execution')
    }
    return {
      executionId: row.execution_id,
      dispatchId: row.dispatch_id,
      taskId: row.task_id,
      runId: row.run_id,
      worktree: row.worktree,
      runtimeEpoch: row.runtime_epoch,
      status: row.status,
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
      result: row.result,
      error: row.error
    }
  }

  events(id: string, after = 0): CodexRuntimeEvent[] {
    this.require(id)
    return (
      this.native.db
        .prepare(`SELECT event_json FROM codex_runtime_events
      WHERE execution_id = ? AND sequence > ? ORDER BY sequence LIMIT 256`)
        .all(id, after) as { event_json: string }[]
    ).map((row) => JSON.parse(row.event_json) as CodexRuntimeEvent)
  }

  save(snapshot: CodexRuntimeResult, event?: CodexRuntimeEvent): void {
    this.native.db.exec('BEGIN IMMEDIATE')
    try {
      const record = this.require(snapshot.receipt.executionId)
      if (
        record.runtimeEpoch !== this.runtimeEpoch ||
        record.worktree !== snapshot.receipt.worktree
      ) {
        throw new Error('Codex execution owner/workspace mismatch')
      }
      if (
        record.receipt &&
        (record.receipt.resolvedExecutablePath !== snapshot.receipt.resolvedExecutablePath ||
          record.receipt.resolvedExecutableVersion !== snapshot.receipt.resolvedExecutableVersion ||
          record.receipt.codexHome !== snapshot.receipt.codexHome ||
          record.receipt.requestedRuntime !== snapshot.receipt.requestedRuntime ||
          record.receipt.approvalPolicy !== snapshot.receipt.approvalPolicy ||
          record.receipt.requestedModel !== snapshot.receipt.requestedModel)
      ) {
        throw new Error('Codex executable, profile or request identity changed mid-execution')
      }
      if (!ACTIVE.has(record.status)) {
        if (
          record.status === snapshot.status &&
          JSON.stringify(record.receipt) === JSON.stringify(snapshot.receipt)
        ) {
          if ((record.result ?? '') === snapshot.text || record.status !== 'COMPLETED') {
            this.native.db.exec('COMMIT')
            return
          }
        }
        throw new Error('Cannot replace a terminal Codex execution')
      }
      if (record.status === 'RUNNING' && snapshot.status === 'STARTING') {
        throw new Error('Codex execution cannot move backwards')
      }
      if (
        (record.receipt?.threadId && record.receipt.threadId !== snapshot.receipt.threadId) ||
        (record.receipt?.turnId && record.receipt.turnId !== snapshot.receipt.turnId)
      ) {
        throw new Error('Codex execution cannot replace runtime identity')
      }
      if (snapshot.status === 'RUNNING' && record.status === 'STARTING') {
        if (
          !snapshot.receipt.threadId ||
          !snapshot.receipt.turnId ||
          snapshot.receipt.effectiveSandbox !== 'READ_ONLY'
        ) {
          throw new Error('Cannot mark an unproven Codex execution running')
        }
        markWorkerDispatchReadyInTransaction.call(this.native, record.dispatchId)
      }
      if (!ACTIVE.has(snapshot.status)) {
        this.settle(record, snapshot)
        if (snapshot.status === 'COMPLETED') {
          this.native.db
            .prepare(`INSERT INTO codex_runtime_results (execution_id, result)
            VALUES (?, ?)`)
            .run(record.executionId, redactString(snapshot.text).slice(0, 128000))
        }
      }
      this.native.db
        .prepare(`UPDATE codex_runtime_executions SET status = ?, receipt_json = ?,
        error = ?, updated_at = datetime('now') WHERE execution_id = ?`)
        .run(
          snapshot.status,
          JSON.stringify(snapshot.receipt),
          snapshot.error ? redactString(snapshot.error).slice(0, 2000) : null,
          record.executionId
        )
      if (event) {
        this.native.db
          .prepare(`INSERT INTO codex_runtime_events (execution_id, sequence, event_json)
          VALUES (?, ?, ?)`)
          .run(record.executionId, event.sequence, JSON.stringify(event))
        this.native.db
          .prepare(`DELETE FROM codex_runtime_events WHERE execution_id = ? AND sequence <= ?`)
          .run(record.executionId, event.sequence - 256)
      }
      this.native.db.exec('COMMIT')
    } catch (error) {
      this.native.db.exec('ROLLBACK')
      throw error
    }
  }

  reconcilePreviousEpoch(): number {
    const rows = this.native.db
      .prepare(`SELECT execution_id FROM codex_runtime_executions
      WHERE runtime_epoch <> ? AND status IN ('STARTING','RUNNING')`)
      .all(this.runtimeEpoch) as { execution_id: string }[]
    this.native.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const record = this.require(row.execution_id)
        this.markUnknown(
          record,
          'Previous runtime is not observable; reconcile before another execution'
        )
        this.native.db
          .prepare(`UPDATE codex_runtime_executions SET status = 'OUTCOME_UNKNOWN',
          error = ?, updated_at = datetime('now') WHERE execution_id = ?`)
          .run('Runtime restart requires reconciliation', record.executionId)
      }
      this.native.db.exec('COMMIT')
      return rows.length
    } catch (error) {
      this.native.db.exec('ROLLBACK')
      throw error
    }
  }

  private settle(record: CodexExecutionRecord, snapshot: CodexRuntimeResult): void {
    if (snapshot.status === 'OUTCOME_UNKNOWN') {
      this.markUnknown(record, snapshot.error ?? 'Runtime outcome unverified')
      return
    }
    const text = redactString(snapshot.text || snapshot.error || snapshot.status).slice(0, 128000)
    if (snapshot.status === 'COMPLETED' && (record.status !== 'RUNNING' || !snapshot.text.trim())) {
      throw new Error('Cannot complete Codex execution without acknowledged start and final result')
    }
    if (record.status === 'STARTING') {
      failWorkerStartInTransaction.call(this.native, record.dispatchId, 'programmatic_start', text)
      if (this.native.getTask(record.taskId)?.status !== 'failed') {
        throw new Error('Native Task still has another authoritative execution')
      }
      this.native.db.prepare('UPDATE tasks SET result = ? WHERE id = ?').run(text, record.taskId)
    } else {
      const settlement = this.native.settleWorkerReportInTransaction({
        taskId: record.taskId,
        dispatchId: record.dispatchId,
        outcome: snapshot.status === 'COMPLETED' ? 'succeeded' : 'failed',
        result: text
      })
      if (settlement.action !== 'settled') {
        throw new Error(`Native settlement rejected: ${settlement.reason}`)
      }
    }
    if (snapshot.status === 'CANCELLED') {
      this.native.db
        .prepare("UPDATE worker_dispatches SET state = 'stopped' WHERE dispatch_id = ?")
        .run(record.dispatchId)
    }
  }

  private markUnknown(record: CodexExecutionRecord, error: string): void {
    this.native.db
      .prepare("UPDATE tasks SET status = 'blocked' WHERE id = ? AND status = 'dispatched'")
      .run(record.taskId)
    this.native.db
      .prepare(`UPDATE worker_dispatches SET stage = 'programmatic_unverifiable',
      last_error = ? WHERE dispatch_id = ?`)
      .run(redactString(error).slice(0, 2000), record.dispatchId)
    this.native.db
      .prepare(`UPDATE dispatch_contexts SET capability_revoked_at =
      COALESCE(capability_revoked_at, datetime('now')) WHERE id = ?`)
      .run(record.dispatchId)
  }
}
