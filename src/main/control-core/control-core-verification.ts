import { z } from 'zod'
import type { LogicalWorkSession, WorkItem } from '../../shared/control-core-contract'
import type { CodexExecutionRecord } from '../runtime/orchestration/codex-execution-store'
import type { CoreRuntimePort } from './control-core-runtime'
import { completionBarrier } from './completion-barrier'
import type { ControlWorkStore } from './control-work-store'
import { TaskJournalStore } from './task-journal'
import { recordVerificationEvidence } from './verification-evidence'

export type CoreVerificationPort = {
  verify: (input: {
    session: LogicalWorkSession
    item: WorkItem
    execution: CodexExecutionRecord
  }) => Promise<{
    passed: boolean
    evidenceRefs: string[]
    reason?: string
    testCommandItemIds?: string[]
  }>
}
const Verdict = z
  .object({
    passed: z.boolean(),
    evidenceRefs: z.array(z.string().min(1).max(1000)).max(64),
    reason: z.string().max(2000).optional(),
    testCommandItemIds: z.array(z.string().min(1).max(256)).max(64).optional()
  })
  .strict()

export class ControlCoreVerification {
  constructor(
    private readonly store: ControlWorkStore,
    private readonly runtime: CoreRuntimePort,
    private readonly verifier: CoreVerificationPort
  ) {}

  async verify(id: string, expectedRevision: number): Promise<WorkItem> {
    const initial = this.store.item(id)
    if (initial.revision !== expectedRevision) {
      throw new Error('Stale WorkItem revision')
    }
    if (initial.status !== 'READY_FOR_REVIEW' || !initial.executionId) {
      throw new Error('WorkItem is not ready for verification')
    }
    const session = this.store.session(initial.logicalWorkSessionId)
    if (session.status !== 'ACTIVE') {
      throw new Error('Logical session is closed')
    }
    const execution = await this.runtime.result(initial.executionId)
    if (
      execution.status !== 'COMPLETED' ||
      execution.taskId !== initial.nativeTaskId ||
      execution.runId !== session.runId ||
      execution.worktree !== session.worktree ||
      !execution.result?.trim()
    ) {
      throw new Error('Execution evidence is incomplete')
    }
    const verdict = Verdict.parse(
      await this.verifier.verify(structuredClone({ session, item: initial, execution }))
    )
    if (verdict.passed && verdict.evidenceRefs.length === 0) {
      throw new Error('Verification requires evidence references')
    }
    return this.store.transaction(() => {
      const current = this.store.item(id)
      if (
        current.revision !== initial.revision ||
        current.executionId !== initial.executionId ||
        current.status !== 'READY_FOR_REVIEW' ||
        this.store.session(session.logicalWorkSessionId).status !== 'ACTIVE'
      ) {
        throw new Error('WorkItem changed during verification')
      }
      const evidenceRecordId = recordVerificationEvidence(
        this.store,
        current,
        verdict.passed,
        verdict.evidenceRefs,
        verdict.testCommandItemIds
      )
      if (!verdict.passed) {
        const rejected = this.store.save({ ...current, status: 'FAILED' })
        this.store.event(rejected, 'WORK_FAILED', {
          verification: 'rejected',
          executionId: current.executionId,
          evidenceRefs: verdict.evidenceRefs,
          evidenceRecordId,
          reason: verdict.reason ?? 'Evidence gate rejected'
        })
        return rejected
      }
      const verified = this.store.save({
        ...current,
        status: 'VERIFIED',
        evidenceRefs: [
          ...new Set([
            ...current.evidenceRefs,
            ...verdict.evidenceRefs,
            ...(evidenceRecordId ? [`evidence:${evidenceRecordId}`] : [])
          ])
        ]
      })
      this.store.event(verified, 'WORK_VERIFIED', { evidenceRefs: verified.evidenceRefs })
      this.completeRoot(session.logicalWorkSessionId)
      return verified
    })
  }

  private completeRoot(sessionId: string): void {
    const session = this.store.session(sessionId)
    const items = this.store.items(sessionId)
    if (!completionBarrier(items, session.rootWorkItemId).ready) {
      return
    }
    const root = this.store.item(session.rootWorkItemId)
    const evidenceRefs = items
      .filter((item) => item.workItemId !== root.workItemId)
      .map((item) => `workitem:${item.workItemId}:verified`)
    this.store.event(root, 'JOIN_READY', {
      requiredWorkItemIds: items
        .filter((item) => item.parentWorkItemId !== null)
        .map((item) => item.workItemId)
    })
    const verified = this.store.save({ ...root, status: 'VERIFIED', evidenceRefs })
    this.store.event(verified, 'WORK_VERIFIED', { evidenceRefs })
    this.store.native.db
      .prepare(
        "UPDATE control_work_sessions SET status='COMPLETED',updated_at=? WHERE id=? AND status='ACTIVE'"
      )
      .run(new Date().toISOString(), sessionId)
    new TaskJournalStore(this.store).capture(sessionId)
  }
}
