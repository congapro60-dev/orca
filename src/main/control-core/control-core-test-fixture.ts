import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import type { CodexExecutionRecord } from '../runtime/orchestration/codex-execution-store'
import { ControlCoreFacade } from './control-core-facade'
import type { CoreRuntimePort } from './control-core-runtime'
import type { CoreVerificationPort } from './control-core-verification'

export function coreFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-core-test-')))
  const databasePath = join(directory, 'orchestration.db')
  let db = new OrchestrationDb(databasePath)
  const records = new Map<string, CodexExecutionRecord>()
  const runtime = {
    start: vi.fn<CoreRuntimePort['start']>(async (taskId, request) => {
      const record: CodexExecutionRecord = {
        executionId: randomUUID(),
        dispatchId: randomUUID(),
        taskId,
        runId: db.getTask(taskId)!.run_id,
        worktree: request.worktree,
        runtimeEpoch: 'fixture',
        status: 'RUNNING',
        receipt: null,
        result: null,
        error: null
      }
      records.set(record.executionId, record)
      return structuredClone(record)
    }),
    get: vi.fn<CoreRuntimePort['get']>((id) => {
      const record = records.get(id)
      if (!record) {
        throw new Error('Unknown fixture execution')
      }
      return structuredClone(record)
    }),
    result: vi.fn<CoreRuntimePort['result']>(async (id) => runtime.get(id)),
    cancel: vi.fn<CoreRuntimePort['cancel']>(async (id) => {
      records.get(id)!.status = 'CANCELLED'
    })
  }
  const verifier = {
    verify: vi.fn<CoreVerificationPort['verify']>(async ({ execution }) => ({
      passed: true,
      evidenceRefs: [`test-verification:${execution.executionId}`]
    }))
  }
  const environment = {
    executablePath: join(directory, 'codex.exe'),
    codexHome: join(directory, 'profile')
  }
  let core = new ControlCoreFacade(db, runtime, environment, verifier)
  return {
    get db() {
      return db
    },
    get core() {
      return core
    },
    directory,
    runtime,
    records,
    verifier,
    environment,
    create(objective = 'Inspect the selected workspace') {
      const session = core.createSession({
        projectId: 'project-test',
        worktree: directory,
        objective,
        doneWhen: ['Return evidence'],
        constraints: ['Do not write files']
      })
      const item = core
        .openSession(session.logicalWorkSessionId)
        .items.find((i) => i.branchId === 'main')!
      return { session, item }
    },
    async complete(id: string) {
      const item = core.item(id)
      const running = await core.start(id, item.revision)
      const record = records.get(running.executionId!)!
      record.status = 'COMPLETED'
      record.result = 'DONE: fixture result, not verification authority'
      return core.refresh(id)
    },
    reopen() {
      db.close()
      db = new OrchestrationDb(databasePath)
      core = new ControlCoreFacade(db, runtime, environment, verifier)
      return core
    },
    dispose() {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
