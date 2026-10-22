import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { CoreRuntimeProfile, WorkContextCapsule } from '../../shared/control-core-contract'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { ControlWorkStore, type NewWorkItem } from './control-work-store'
import {
  ControlCoreRuntime,
  type CoreRuntimeEnvironment,
  type CoreRuntimePort
} from './control-core-runtime'
import { ControlCoreVerification, type CoreVerificationPort } from './control-core-verification'
import { PeerMailbox, type NewPeerMessage } from './peer-mailbox'
import { TaskJournalStore } from './task-journal'
import {
  ControlMemoryStore,
  type NewCandidateMemory,
  type MemoryVersion
} from './control-memory-store'
import { MemoryPromotionGate, type MemoryPromotionRequest } from './memory-promotion-gate'
import { ControlEvidenceStore } from './control-evidence-store'
import { reconcileResume, type ReconcileInput } from './resume-reconcile'

/** User workflow boundary; dependency ports are supplied by the owning host, never a worker. */
export class ControlCoreFacade {
  private readonly store: ControlWorkStore
  private readonly workRuntime: ControlCoreRuntime
  private readonly verification: ControlCoreVerification
  private readonly mailbox: PeerMailbox
  private readonly memory: ControlMemoryStore

  constructor(
    native: OrchestrationDb,
    runtime: CoreRuntimePort,
    environment: CoreRuntimeEnvironment | (() => CoreRuntimeEnvironment),
    verifier: CoreVerificationPort = {
      verify: async () => {
        throw new Error('Verification is not configured')
      }
    }
  ) {
    this.store = new ControlWorkStore(native)
    this.workRuntime = new ControlCoreRuntime(this.store, runtime, environment)
    this.verification = new ControlCoreVerification(this.store, runtime, verifier)
    this.mailbox = new PeerMailbox(this.store)
    this.memory = new ControlMemoryStore(this.store)
  }

  createSession(input: {
    projectId: string
    worktree: string
    objective: string
    doneWhen?: string[]
    constraints?: string[]
    permissionMode?: 'READ_ONLY' | 'WORKSPACE_WRITE'
  }) {
    if (!isAbsolute(input.worktree)) {
      throw new Error('Project workspace must be absolute')
    }
    const worktree = realpathSync(input.worktree)
    if (!statSync(worktree).isDirectory()) {
      throw new Error('Project workspace must be a directory')
    }
    return this.store.create(input.projectId, worktree, input.objective, {
      doneWhen: input.doneWhen,
      constraints: input.constraints,
      permissionMode: input.permissionMode
    })
  }

  openSession(id: string) {
    for (const item of this.store.items(id)) {
      if (['WAITING', 'RUNNING', 'BLOCKED'].includes(item.status)) {
        this.workRuntime.refresh(item.workItemId)
      }
    }
    return {
      session: this.store.session(id),
      items: this.store.items(id),
      events: this.store.events(id)
    }
  }

  listSessions(projectId: string) {
    return this.store.sessions(projectId)
  }
  createMemoryCandidate(input: NewCandidateMemory) {
    return this.memory.create(input)
  }
  memoryCandidates(projectId: string) {
    return this.memory.list(projectId)
  }
  rejectMemoryCandidate(id: string, expected: MemoryVersion) {
    return this.memory.reject(id, expected)
  }
  canonicalMemory(projectId: string, key: string) {
    return this.memory.canonical(projectId, key)
  }
  promoteMemory(input: MemoryPromotionRequest) {
    return new MemoryPromotionGate(this.memory).promote(input)
  }
  item(id: string) {
    return this.store.item(id)
  }
  events(sessionId: string, after = 0) {
    return this.store.events(sessionId, after)
  }
  journal(sessionId: string) {
    const journals = new TaskJournalStore(this.store)
    return (
      journals.get(sessionId) ??
      (this.store.session(sessionId).status === 'COMPLETED' ? journals.capture(sessionId) : null)
    )
  }
  recordDecision(sessionId: string, decision: string, evidenceRefs: string[] = []) {
    const value = z.string().trim().min(1).max(2000).parse(decision)
    const refs = z.array(z.string().min(1).max(1000)).max(64).parse(evidenceRefs)
    const session = this.store.session(sessionId)
    if (session.status !== 'ACTIVE') {
      throw new Error('Logical session is closed')
    }
    this.store.event(this.store.item(session.rootWorkItemId), 'DECISION_RECORDED', {
      decision: value,
      evidenceRefs: refs
    })
  }
  addBranch(sessionId: string, input: NewWorkItem) {
    return this.store.addItem(sessionId, this.store.session(sessionId).rootWorkItemId, input)
  }
  addFollowup(sessionId: string, input: NewWorkItem) {
    return this.store.transaction(() => {
      const session = this.store.session(sessionId)
      if (session.status === 'CANCELLED' || session.status === 'BLOCKED') {
        throw new Error('Logical session cannot accept a follow-up')
      }
      if (session.status === 'COMPLETED') {
        this.store.native.db
          .prepare("UPDATE control_work_sessions SET status='ACTIVE',updated_at=? WHERE id=?")
          .run(new Date().toISOString(), sessionId)
      }
      return this.addBranch(sessionId, input)
    })
  }
  start(
    id: string,
    expectedRevision: number,
    context: readonly WorkContextCapsule[] = [],
    profile?: CoreRuntimeProfile
  ) {
    const session = this.store.session(this.store.item(id).logicalWorkSessionId)
    return this.workRuntime.start(
      id,
      expectedRevision,
      context,
      profile ?? { runtime: 'codex', permissionMode: session.permissionMode }
    )
  }
  refresh(id: string) {
    return this.workRuntime.refresh(id)
  }
  wait(id: string) {
    return this.workRuntime.wait(id)
  }
  cancel(id: string) {
    return this.workRuntime.cancel(id)
  }
  reconcileResume(input: ReconcileInput) {
    return reconcileResume(this.store, input)
  }
  latestDecision(itemId: string) {
    return new ControlEvidenceStore(this.store).latestDecision(itemId)
  }
  verify(id: string, expectedRevision: number) {
    return this.verification.verify(id, expectedRevision)
  }

  publishArtifact(id: string, expectedRevision: number, artifactRef: string) {
    const ref = z.string().min(1).max(1000).parse(artifactRef)
    return this.store.transaction(() => {
      const item = this.store.item(id)
      if (item.revision !== expectedRevision) {
        throw new Error('Stale WorkItem revision')
      }
      if (item.status === 'VERIFIED') {
        throw new Error('Verified evidence cannot be rewritten')
      }
      const updated = this.store.save({
        ...item,
        artifactRefs: [...new Set([...item.artifactRefs, ref])]
      })
      this.store.event(updated, 'ARTIFACT_PUBLISHED', { artifactRef: ref })
      return updated
    })
  }

  sendMessage(trustedSenderItemId: string, message: NewPeerMessage) {
    return this.mailbox.send(trustedSenderItemId, message)
  }
  inbox(trustedRecipientItemId: string, afterMessageId?: string) {
    return this.mailbox.inbox(trustedRecipientItemId, afterMessageId)
  }
}
