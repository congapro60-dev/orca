import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  EvidenceRecord,
  WorkspaceCheckpoint,
  ResumeDecision,
  HandoffArtifactV0
} from '../../shared/control-evidence-contract'
import { redactString } from '../observability/redactor'
import { safeMemoryReference } from './memory-safe-reference'
import type { ControlWorkStore } from './control-work-store'
import { handoffContentHash, assertHandoffExecutions } from './handoff-integrity'
import { writeResumeDecision, readLatestResumeDecision } from './resume-decision-store'

export function evidenceContentHash(record: Omit<EvidenceRecord, 'contentHash'>): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
}

type EvidenceAppendInput = Omit<
  EvidenceRecord,
  'evidenceId' | 'contentHash' | 'createdAt' | 'baseline' | 'observed'
> & {
  baseline: WorkspaceCheckpoint | null
  observed: WorkspaceCheckpoint | null
}
function checkpointHash(itemId: string, snapshot: string): string {
  return createHash('sha256')
    .update(JSON.stringify([itemId, snapshot]))
    .digest('hex')
}

type CheckpointRow = {
  id: string
  item_id: string
  snapshot: string
  content_hash: string | null
  created_at: string
}

function checkedCheckpoint(row: CheckpointRow): WorkspaceCheckpoint {
  if (!row.content_hash || checkpointHash(row.item_id, row.snapshot) !== row.content_hash) {
    throw new Error('Checkpoint integrity mismatch or historical capture unverifiable')
  }
  const checkpoint = JSON.parse(row.snapshot) as WorkspaceCheckpoint
  if (checkpoint.checkpointId !== row.id || checkpoint.capturedAt !== row.created_at) {
    throw new Error('Checkpoint persisted identity mismatch')
  }
  return checkpoint
}
function summary(
  checkpoint: WorkspaceCheckpoint | null
): Omit<WorkspaceCheckpoint, 'files'> | null {
  if (!checkpoint) {
    return null
  }
  const { files: _files, ...metadata } = checkpoint
  return metadata
}

export class ControlEvidenceStore {
  constructor(readonly work: ControlWorkStore) {}

  checkpoint(itemId: string, snapshot: WorkspaceCheckpoint): WorkspaceCheckpoint {
    const item = this.work.item(itemId)
    const session = this.work.session(item.logicalWorkSessionId)
    if (snapshot.worktree !== session.worktree) {
      throw new Error('Checkpoint workspace identity mismatch')
    }
    const serialized = JSON.stringify(snapshot)
    this.work.native.db
      .prepare(
        'INSERT INTO control_workspace_checkpoints (id,item_id,snapshot,content_hash,created_at) VALUES (?,?,?,?,?)'
      )
      .run(
        snapshot.checkpointId,
        itemId,
        serialized,
        checkpointHash(itemId, serialized),
        snapshot.capturedAt
      )
    return structuredClone(snapshot)
  }

  latestCheckpoint(itemId: string): WorkspaceCheckpoint | null {
    this.work.item(itemId)
    const row = this.work.native.db
      .prepare(
        'SELECT id,item_id,snapshot,content_hash,created_at FROM control_workspace_checkpoints WHERE item_id=? ORDER BY rowid DESC LIMIT 1'
      )
      .get(itemId) as CheckpointRow | undefined
    if (!row) {
      return null
    }
    const checkpoint = checkedCheckpoint(row)
    if (
      checkpoint.worktree !==
      this.work.session(this.work.item(itemId).logicalWorkSessionId).worktree
    ) {
      throw new Error('Checkpoint workspace identity mismatch')
    }
    return checkpoint
  }

  registeredCheckpoint(itemId: string, checkpoint: WorkspaceCheckpoint): WorkspaceCheckpoint {
    const item = this.work.item(itemId)
    const row = this.work.native.db
      .prepare(
        'SELECT id,item_id,snapshot,content_hash,created_at FROM control_workspace_checkpoints WHERE id=?'
      )
      .get(checkpoint.checkpointId) as CheckpointRow | undefined
    if (!row || row.item_id !== item.workItemId || row.snapshot !== JSON.stringify(checkpoint)) {
      throw new Error('Checkpoint is not a registered immutable snapshot')
    }
    const checked = checkedCheckpoint(row)
    if (checked.worktree !== this.work.session(item.logicalWorkSessionId).worktree) {
      throw new Error('Checkpoint workspace identity mismatch')
    }
    return checked
  }

  append(input: EvidenceAppendInput): EvidenceRecord {
    const item = this.work.item(input.workItemId)
    const session = this.work.session(item.logicalWorkSessionId)
    if (
      input.logicalWorkSessionId !== item.logicalWorkSessionId ||
      (input.baseline && input.baseline.worktree !== session.worktree) ||
      (input.observed && input.observed.worktree !== session.worktree)
    ) {
      throw new Error('Evidence identity does not belong to logical work')
    }
    for (const checkpoint of [input.baseline, input.observed]) {
      if (!checkpoint) {
        continue
      }
      const registered = this.work.native.db
        .prepare(
          'SELECT id,item_id,snapshot,content_hash,created_at FROM control_workspace_checkpoints WHERE id=?'
        )
        .get(checkpoint.checkpointId) as CheckpointRow | undefined
      if (
        !registered ||
        registered.item_id !== item.workItemId ||
        registered.snapshot !== JSON.stringify(checkpoint)
      ) {
        throw new Error('Evidence checkpoint is not a registered immutable snapshot')
      }
      checkedCheckpoint(registered)
    }
    if (input.executionId) {
      const attempt = this.work.native.db
        .prepare('SELECT item_id FROM control_work_attempts WHERE execution_id=?')
        .get(input.executionId) as { item_id: string } | undefined
      if (
        attempt?.item_id !== item.workItemId ||
        (input.runtimeReceipt &&
          (input.runtimeReceipt.executionId !== input.executionId ||
            input.runtimeReceipt.worktree !== session.worktree))
      ) {
        throw new Error('Evidence execution does not belong to WorkItem attempt')
      }
    }
    const content: Omit<EvidenceRecord, 'contentHash'> = {
      ...structuredClone(input),
      baseline: summary(input.baseline),
      observed: summary(input.observed),
      evidenceId: randomUUID(),
      createdAt: new Date().toISOString(),
      result: input.result === null ? null : redactString(input.result).slice(0, 128000),
      sourceEvidenceRefs: input.sourceEvidenceRefs.map(safeMemoryReference),
      commands:
        input.commands?.map((command) => ({
          ...command,
          command: redactString(command.command).slice(0, 2048)
        })) ?? null,
      tests:
        input.tests?.map((test) => ({
          ...test,
          command: redactString(test.command).slice(0, 2048)
        })) ?? null
    }
    if ((content.commands?.length ?? 0) > 64 || (content.tests?.length ?? 0) > 64) {
      throw new Error('Evidence command bound exceeded')
    }
    const record: EvidenceRecord = { ...content, contentHash: evidenceContentHash(content) }
    const snapshot = JSON.stringify(record)
    if (snapshot.length > 4 * 1024 * 1024) {
      throw new Error('Evidence snapshot exceeds bound')
    }
    this.work.native.db
      .prepare(`INSERT INTO control_evidence_records
      (id,session_id,item_id,execution_id,snapshot,content_hash,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(
        record.evidenceId,
        record.logicalWorkSessionId,
        record.workItemId,
        record.executionId,
        snapshot,
        record.contentHash,
        record.createdAt
      )
    return record
  }

  get(id: string): EvidenceRecord {
    const row = this.work.native.db
      .prepare('SELECT snapshot,content_hash FROM control_evidence_records WHERE id=?')
      .get(id) as { snapshot: string; content_hash: string } | undefined
    if (!row) {
      throw new Error('Unknown EvidenceRecord')
    }
    const record = JSON.parse(row.snapshot) as EvidenceRecord
    const { contentHash, ...content } = record
    if (contentHash !== row.content_hash || evidenceContentHash(content) !== contentHash) {
      throw new Error('Evidence integrity mismatch')
    }
    return record
  }

  list(itemId: string): EvidenceRecord[] {
    this.work.item(itemId)
    const rows = this.work.native.db
      .prepare(
        'SELECT id FROM control_evidence_records WHERE item_id=? ORDER BY rowid DESC LIMIT 100'
      )
      .all(itemId) as { id: string }[]
    return rows.map((row) => this.get(row.id))
  }

  decision(input: Omit<ResumeDecision, 'decisionId' | 'createdAt'>): ResumeDecision {
    return writeResumeDecision(this.work, input)
  }

  latestDecision(itemId: string): ResumeDecision | null {
    return readLatestResumeDecision(this.work, itemId)
  }

  handoff(input: Omit<HandoffArtifactV0, 'handoffId' | 'createdAt'>): HandoffArtifactV0 {
    const item = this.work.item(input.workItemId)
    if (item.logicalWorkSessionId !== input.logicalWorkSessionId) {
      throw new Error('Handoff logical identity mismatch')
    }
    if (input.worktree !== this.work.session(item.logicalWorkSessionId).worktree) {
      throw new Error('Handoff workspace identity mismatch')
    }
    assertHandoffExecutions(this.work, item.workItemId, [
      input.sourceExecutionId,
      input.targetExecutionId
    ])
    const text = (value: string) => redactString(z.string().max(8000).parse(value))
    const refs = (values: string[]) =>
      z.array(z.string().max(1000)).max(64).parse(values).map(safeMemoryReference)
    for (const values of [
      input.acceptanceCriteria,
      input.constraints,
      input.completedWork,
      input.pendingWork,
      input.decisions,
      input.changedFiles,
      input.tests ?? []
    ]) {
      if (values.length > 64) {
        throw new Error('Handoff field exceeds item bound')
      }
    }
    const record: HandoffArtifactV0 = {
      ...structuredClone(input),
      handoffId: randomUUID(),
      createdAt: new Date().toISOString(),
      objective: text(input.objective),
      acceptanceCriteria: input.acceptanceCriteria.map(text),
      constraints: input.constraints.map(text),
      completedWork: input.completedWork.map(text),
      pendingWork: input.pendingWork.map(text),
      decisions: input.decisions.map(text),
      evidenceRefs: refs(input.evidenceRefs),
      changedFiles: input.changedFiles.map(safeMemoryReference),
      worktree: safeMemoryReference(input.worktree),
      tests: input.tests?.map((test) => ({ ...test, command: text(test.command) })) ?? null
    }
    const snapshot = JSON.stringify(record)
    if (snapshot.length > 64000) {
      throw new Error('Handoff exceeds context bound')
    }
    this.work.native.db
      .prepare(
        'INSERT INTO control_handoff_artifacts (id,item_id,snapshot,content_hash,created_at) VALUES (?,?,?,?,?)'
      )
      .run(
        record.handoffId,
        record.workItemId,
        snapshot,
        handoffContentHash(item.workItemId, snapshot),
        record.createdAt
      )
    return record
  }
}
