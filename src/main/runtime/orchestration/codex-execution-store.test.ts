import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from './db'
import { CodexExecutionStore } from './codex-execution-store'
import type {
  CodexRuntimeReceipt,
  CodexRuntimeResult
} from '../../../shared/codex-runtime-contract'

const databases: OrchestrationDb[] = []
const dirs: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture(file = ':memory:') {
  const db = new OrchestrationDb(file)
  databases.push(db)
  const run = db.createRun({
    objective: 'Read-only inspection',
    coordinatorHandle: 'control-test',
    coordinatorPaneKey: 'control-test'
  })
  const task = db.createTask({ spec: 'Inspect repository', runId: run.id })
  const store = new CodexExecutionStore(db, 'epoch-a')
  const executionId = randomUUID()
  const row = store.accept(task.id, executionId, '/test/repo')
  const receipt: CodexRuntimeReceipt = {
    executionId,
    worktree: '/test/repo',
    codexHome: '/test/profile',
    requestedRuntime: 'codex',
    resolvedExecutablePath: '/installed/codex',
    resolvedExecutableVersion: 'codex-cli test',
    runtimeProtocol: 'codex-app-server-jsonrpc-v2',
    requestedModel: null,
    resolvedModel: null,
    actualModel: 'UNKNOWN_UNVERIFIED',
    effectiveSandbox: 'UNKNOWN_UNVERIFIED',
    approvalPolicy: 'never',
    threadId: null,
    turnId: null
  }
  const snapshot: CodexRuntimeResult = { receipt, status: 'STARTING', text: '', error: null }
  const running = () => {
    snapshot.status = 'RUNNING'
    Object.assign(receipt, {
      threadId: 'thread-a',
      turnId: 'turn-a',
      effectiveSandbox: 'READ_ONLY'
    })
    store.save(snapshot)
  }
  return { db, run, task, store, row, snapshot, running }
}

describe('Native Orca Codex execution linkage', () => {
  it('keeps an execution result snapshot independent of later Task edits', () => {
    const { db, store, row, snapshot, running } = fixture()
    running()
    store.save({ ...snapshot, status: 'COMPLETED', text: 'Original verified transcript' })
    db.db
      .prepare('UPDATE tasks SET result = ? WHERE id = ?')
      .run('Changed later task projection', row.taskId)
    expect(store.require(row.executionId).result).toBe('Original verified transcript')
  })

  it('does not fabricate a missing historical execution result from mutable Task.result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-codex-db-'))
    dirs.push(dir)
    const file = join(dir, 'orchestration.db')
    const { db, store, row, snapshot, running } = fixture(file)
    running()
    store.save({ ...snapshot, status: 'COMPLETED', text: 'original' })
    db.db.prepare('DELETE FROM codex_runtime_results WHERE execution_id = ?').run(row.executionId)
    db.db.prepare('UPDATE tasks SET result = ? WHERE id = ?').run('changed later', row.taskId)
    databases.splice(databases.indexOf(db), 1)
    db.close()
    const fresh = new OrchestrationDb(file)
    databases.push(fresh)
    expect(new CodexExecutionStore(fresh, 'next-epoch').require(row.executionId).result).toBeNull()
  })

  it.each(['resetTasks', 'resetAll'] as const)(
    'fences %s for an outcome-unknown execution',
    (scope) => {
      const { db, store, row, snapshot, running } = fixture()
      running()
      store.save({ ...snapshot, status: 'OUTCOME_UNKNOWN', error: 'Lost contact' })
      expect(store.require(row.executionId).result).toBeNull()
      expect(() => db[scope]()).toThrow(/Cannot reset/)
      expect(store.require(row.executionId).status).toBe('OUTCOME_UNKNOWN')
    }
  )
  it('does not let legacy terminal recovery interpret a programmatic worker as missing', () => {
    const { db, row } = fixture()
    expect(db.listLegacyWorkerTerminalRecoveryRows()).toEqual([])
    expect(() => db.reconcileMissingWorkerTerminal(row.dispatchId, 'missing terminal')).toThrow(
      /runtime reconciliation/
    )
    expect(db.getTask(row.taskId)?.status).toBe('dispatched')
  })
  it('atomically accepts one Dispatch/execution without replacing task identity', () => {
    const { db, store, row, task, run } = fixture()
    expect(store.require(row.executionId)).toMatchObject({
      taskId: task.id,
      runId: run.id,
      status: 'STARTING'
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getWorkerDispatch(row.dispatchId)?.state).toBe('starting')
  })

  it('rolls back the second acceptance on a duplicate execution id or busy workspace', () => {
    const { db, store, row, run } = fixture()
    const task = db.createTask({ spec: 'second task', runId: run.id })
    expect(() => store.accept(task.id, row.executionId, '/other')).toThrow()
    expect(() => store.accept(task.id, randomUUID(), row.worktree)).toThrow()
    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('persists native result, terminal dispatch and receipt through a fresh DB connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-codex-db-'))
    dirs.push(dir)
    const file = join(dir, 'orchestration.db')
    const { db, store, row, snapshot, running } = fixture(file)
    running()
    snapshot.status = 'COMPLETED'
    snapshot.text = 'Root /test/repo; HEAD abc; clean; no changes'
    store.save(snapshot, {
      sequence: 1,
      at: '2026-09-27',
      kind: 'TERMINAL',
      method: 'execution/settled'
    })
    store.save(snapshot)
    expect(db.getTask(row.taskId)?.result).toBe(snapshot.text)
    expect(db.getDispatchContextById(row.dispatchId)?.status).toBe('completed')
    databases.splice(databases.indexOf(db), 1)
    db.close()
    const fresh = new OrchestrationDb(file)
    databases.push(fresh)
    const reopened = new CodexExecutionStore(fresh, 'epoch-b')
    expect(reopened.reconcilePreviousEpoch()).toBe(0)
    expect(reopened.require(row.executionId)).toMatchObject({
      status: 'COMPLETED',
      result: snapshot.text,
      receipt: { turnId: 'turn-a' }
    })
    expect(reopened.events(row.executionId)).toHaveLength(1)
  })

  it('does not equate a runtime DONE result with acknowledged dispatch start', () => {
    const { store, snapshot } = fixture()
    expect(() => store.save({ ...snapshot, status: 'COMPLETED', text: 'DONE' })).toThrow(
      /acknowledged start/
    )
    expect(store.require(snapshot.receipt.executionId).status).toBe('STARTING')
  })

  it('keeps an unobserved previous runtime blocked rather than dead or automatically restarted', () => {
    const { db, store, row, running, snapshot, run } = fixture()
    running()
    const fresh = new CodexExecutionStore(db, 'epoch-b')
    expect(fresh.reconcilePreviousEpoch()).toBe(1)
    expect(fresh.require(row.executionId).status).toBe('OUTCOME_UNKNOWN')
    expect(db.getTask(row.taskId)?.status).toBe('blocked')
    expect(db.getDispatchContextById(row.dispatchId)?.status).toBe('dispatched')
    const other = db.createTask({ spec: 'unsafe replay', runId: run.id })
    expect(() => fresh.accept(other.id, randomUUID(), row.worktree)).toThrow()
    expect(() => store.save({ ...snapshot, status: 'COMPLETED', text: 'late' })).toThrow(/terminal/)
    expect(() => fresh.save({ ...snapshot, status: 'COMPLETED', text: 'late' })).toThrow(/owner/)
  })

  it('records pre-start failure and cancellation in native state without worker_done', () => {
    const { db, store, row, snapshot } = fixture()
    store.save({ ...snapshot, status: 'CANCELLED', error: 'Cancelled before turn', text: '' })
    expect(db.getTask(row.taskId)).toMatchObject({
      status: 'failed',
      result: 'Cancelled before turn'
    })
    expect(db.getWorkerDispatch(row.dispatchId)?.state).toBe('stopped')
    expect(store.require(row.executionId).status).toBe('CANCELLED')
  })

  it('rolls back native ready transition when event persistence fails', () => {
    const { db, store, row, snapshot } = fixture()
    const event = { sequence: 1, at: 'now', kind: 'STARTING' as const, method: 'execution/start' }
    store.save(snapshot, event)
    expect(() =>
      store.save(
        {
          ...snapshot,
          status: 'RUNNING',
          receipt: {
            ...snapshot.receipt,
            effectiveSandbox: 'READ_ONLY',
            threadId: 'thread-a',
            turnId: 'turn-a'
          }
        },
        event
      )
    ).toThrow()
    expect(store.require(row.executionId).status).toBe('STARTING')
    expect(db.getWorkerDispatch(row.dispatchId)?.state).toBe('starting')
  })

  it('rejects executable/profile identity substitution after acceptance', () => {
    const { store, row, snapshot, db } = fixture()
    store.save(snapshot)
    const replaced = {
      ...snapshot,
      receipt: { ...snapshot.receipt, resolvedExecutablePath: '/other/codex' }
    }
    expect(() => store.save(replaced)).toThrow(/identity changed/)
    expect(store.require(row.executionId).receipt?.resolvedExecutablePath).toBe('/installed/codex')
    expect(db.getWorkerDispatch(row.dispatchId)?.state).toBe('starting')
  })

  it.each(['resetTasks', 'resetAll'] as const)(
    'keeps explicit native %s compatible with execution records',
    (scope) => {
      const { db, store, row, snapshot } = fixture()
      store.save({ ...snapshot, status: 'FAILED', error: 'Stopped before launch' })
      db[scope]()
      expect(() => store.require(row.executionId)).toThrow(/Unknown/)
      expect(db.db.prepare('SELECT COUNT(*) AS n FROM codex_runtime_executions').get()?.n).toBe(0)
    }
  )
})
