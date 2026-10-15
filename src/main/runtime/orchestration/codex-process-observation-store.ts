import type { OrchestrationDb } from './db'
import { z } from 'zod'
import type { CodexProcessObservation } from '../../../shared/codex-process-contract'

const Observations = z
  .array(
    z
      .object({
        incarnationId: z.string().min(1).max(128),
        pid: z.number().int().positive().nullable(),
        scope: z.enum(['app-server-child', 'owned-process-launcher']),
        verdict: z.enum(['live', 'unverifiable', 'exited']),
        observedAt: z.string().datetime(),
        exitCode: z.number().int().nullable(),
        signal: z.string().max(80).nullable(),
        treeVerdict: z.enum(['exited', 'unverifiable']).optional(),
        ownedTree: z
          .object({
            protocol: z.literal('orca-owned-process-v1'),
            launcherSha256: z.string().regex(/^[a-f0-9]{64}$/),
            rootPid: z.number().int().positive().max(0xffffffff),
            activeProcesses: z.literal(0),
            totalProcesses: z.number().int().positive().max(0xffffffff),
            childExitCode: z.number().int().nonnegative().max(0xffffffff)
          })
          .strict()
          .optional()
      })
      .strict()
  )
  .max(32)

function validated(values: unknown): CodexProcessObservation[] {
  const observations = Observations.parse(values)
  const first = observations[0]
  let exited = false
  let proof: string | undefined
  for (const observation of observations) {
    if (
      observation.incarnationId !== first.incarnationId ||
      observation.pid !== first.pid ||
      observation.scope !== first.scope ||
      (exited && observation.verdict !== 'exited') ||
      (observation.treeVerdict === 'exited' && observation.verdict !== 'exited')
    ) {
      throw new Error('Codex process observation identity or lifecycle mismatch')
    }
    if (observation.ownedTree) {
      const snapshot = JSON.stringify(observation.ownedTree)
      if (
        observation.scope !== 'owned-process-launcher' ||
        observation.pid === null ||
        observation.pid === observation.ownedTree.rootPid ||
        observation.verdict !== 'exited' ||
        observation.treeVerdict !== 'exited' ||
        observation.exitCode !== 0 ||
        observation.signal !== null ||
        (proof !== undefined && proof !== snapshot)
      ) {
        throw new Error('Codex owned tree proof identity or lifecycle mismatch')
      }
      proof = snapshot
    } else if (proof !== undefined) {
      throw new Error('Codex owned tree proof cannot be removed')
    }
    exited ||= observation.verdict === 'exited'
  }
  return observations
}

export function readProcessObservations(
  db: OrchestrationDb,
  id: string
): CodexProcessObservation[] {
  const row = db.db
    .prepare(
      'SELECT snapshot,content_hash FROM codex_runtime_process_observations WHERE execution_id=?'
    )
    .get(id) as { snapshot: string; content_hash: string | null } | undefined
  if (!row) {
    return []
  }
  if (!row.content_hash || observationHash(id, row.snapshot) !== row.content_hash) {
    throw new Error(
      'Codex process observation integrity mismatch or historical capture unverifiable'
    )
  }
  return validated(JSON.parse(row.snapshot))
}

function observationHash(id: string, snapshot: string): string {
  return createHash('sha256')
    .update(JSON.stringify([id, snapshot]))
    .digest('hex')
}

export function writeProcessObservations(
  db: OrchestrationDb,
  id: string,
  values: CodexProcessObservation[]
): void {
  if (values.length > 32) {
    throw new Error('Excessive Codex process observations')
  }
  const snapshot = JSON.stringify(validated(values))
  const incarnation = values[0]?.incarnationId
  if (
    incarnation &&
    db.db
      .prepare(
        "SELECT 1 FROM codex_runtime_process_observations WHERE execution_id<>? AND CASE WHEN json_valid(snapshot) THEN json_extract(snapshot,'$[0].incarnationId') END=? LIMIT 1"
      )
      .get(id, incarnation)
  ) {
    throw new Error('Codex process incarnation is already bound to another execution')
  }
  db.db
    .prepare(
      'INSERT INTO codex_runtime_process_observations (execution_id,snapshot,content_hash) VALUES (?,?,?)'
    )
    .run(id, snapshot, observationHash(id, snapshot))
}
import { createHash } from 'node:crypto'
