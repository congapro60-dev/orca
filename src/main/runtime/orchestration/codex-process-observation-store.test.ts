import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import {
  readProcessObservations,
  writeProcessObservations
} from './codex-process-observation-store'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexExecutionStore } from './codex-execution-store'
import type { CodexProcessObservation } from '../../../shared/codex-process-contract'

const owned: CodexProcessObservation = {
  incarnationId: 'owned-launch-1',
  pid: 7,
  scope: 'owned-process-launcher',
  verdict: 'exited',
  treeVerdict: 'exited',
  observedAt: new Date().toISOString(),
  exitCode: 0,
  signal: null,
  ownedTree: {
    protocol: 'orca-owned-process-v1',
    launcherSha256: 'a'.repeat(64),
    rootPid: 8,
    activeProcesses: 0,
    totalProcesses: 2,
    childExitCode: 0
  }
}

const dbs: OrchestrationDb[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))
describe('Process evidence lifecycle validation', () => {
  it('retains owned proof through SQLite reopen and prevents incarnation reuse', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-owned-proof-'))
    const file = join(directory, 'orchestration.db')
    let db = new OrchestrationDb(file)
    try {
      const run = db.createRun({
        objective: 'Proof',
        coordinatorHandle: 'core',
        coordinatorPaneKey: 'core'
      })
      const task = db.createTask({ spec: 'Inspect', runId: run.id })
      const executionId = randomUUID()
      new CodexExecutionStore(db, 'owner').accept(task.id, executionId, directory)
      writeProcessObservations(db, executionId, [owned])
      db.close()
      db = new OrchestrationDb(file)
      expect(readProcessObservations(db, executionId)).toEqual([owned])
      const otherTask = db.createTask({ spec: 'Other', runId: run.id })
      const otherId = randomUUID()
      new CodexExecutionStore(db, 'owner').accept(otherTask.id, otherId, join(directory, 'other'))
      expect(() => writeProcessObservations(db, otherId, [owned])).toThrow(/already bound/)
      expect(readProcessObservations(db, otherId)).toEqual([])
      db.db
        .prepare('UPDATE codex_runtime_process_observations SET snapshot=? WHERE execution_id=?')
        .run('{', executionId)
      expect(() => readProcessObservations(db, executionId)).toThrow(/integrity/)
      const independent = { ...owned, incarnationId: 'independent-launch' }
      expect(() => writeProcessObservations(db, otherId, [independent])).not.toThrow()
      expect(readProcessObservations(db, otherId)).toEqual([independent])
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects proof from a wrong scope, root, unsuccessful launcher or changing proof', () => {
    const db = new OrchestrationDb(':memory:')
    dbs.push(db)
    const invalid: CodexProcessObservation[][] = [
      [{ ...owned, scope: 'app-server-child' }],
      [{ ...owned, ownedTree: { ...owned.ownedTree!, rootPid: owned.pid! } }],
      [{ ...owned, exitCode: 1 }],
      [{ ...owned, signal: 'SIGKILL' }],
      [owned, { ...owned, ownedTree: { ...owned.ownedTree!, launcherSha256: 'b'.repeat(64) } }],
      [owned, { ...owned, ownedTree: undefined }]
    ]
    for (const observations of invalid) {
      expect(() => writeProcessObservations(db, 'missing', observations)).toThrow(
        /owned tree proof/
      )
    }
  })

  it('rejects forged tree exit, identity changes, and resurrected process before persistence', () => {
    const db = new OrchestrationDb(':memory:')
    dbs.push(db)
    const live = {
      incarnationId: 'host-child',
      pid: 7,
      scope: 'app-server-child' as const,
      verdict: 'live' as const,
      observedAt: new Date().toISOString(),
      exitCode: null,
      signal: null
    }
    expect(() =>
      writeProcessObservations(db, 'missing', [{ ...live, treeVerdict: 'exited' }])
    ).toThrow(/lifecycle/)
    expect(() => writeProcessObservations(db, 'missing', [live, { ...live, pid: 8 }])).toThrow(
      /identity/
    )
    expect(() =>
      writeProcessObservations(db, 'missing', [{ ...live, verdict: 'exited' }, live])
    ).toThrow(/lifecycle/)
    expect(() =>
      writeProcessObservations(db, 'missing', [{ ...live, extra: 'secret' } as never])
    ).toThrow()
    expect(
      db.db.prepare('SELECT count(*) AS n FROM codex_runtime_process_observations').get()?.n
    ).toBe(0)
  })
})
