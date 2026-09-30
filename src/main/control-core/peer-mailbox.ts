import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PeerMessage } from '../../shared/control-core-contract'
import { redactValue } from '../observability/redactor'
import type { ControlWorkStore } from './control-work-store'

const MessageInput = z
  .object({
    logicalWorkSessionId: z.string().uuid(),
    toWorkItemId: z.string().uuid(),
    type: z.enum([
      'QUESTION',
      'ANSWER',
      'PROGRESS',
      'RESULT',
      'BLOCKER',
      'REVIEW_REQUEST',
      'REVIEW_RESULT',
      'SPAWN_PROPOSAL',
      'HANDOFF'
    ]),
    payload: z.record(z.string(), z.unknown()),
    artifactRefs: z.array(z.string().min(1).max(1000)).max(64).default([]),
    evidenceRefs: z.array(z.string().min(1).max(1000)).max(64).default([]),
    requiresResponse: z.boolean().default(false)
  })
  .strict()
export type NewPeerMessage = z.input<typeof MessageInput>

export class PeerMailbox {
  constructor(private readonly store: ControlWorkStore) {}

  send(trustedSenderItemId: string, input: NewPeerMessage): PeerMessage {
    const value = MessageInput.parse(input)
    if (JSON.stringify(value.payload).length > 16000) {
      throw new Error('Peer message payload exceeds limit')
    }
    return this.store.transaction(() => {
      const from = this.store.item(trustedSenderItemId)
      const to = this.store.item(value.toWorkItemId)
      if (
        from.logicalWorkSessionId !== value.logicalWorkSessionId ||
        to.logicalWorkSessionId !== value.logicalWorkSessionId
      ) {
        throw new Error('Peer message cannot cross logical sessions')
      }
      const count = this.store.native.db
        .prepare('SELECT COUNT(*) AS count FROM control_peer_messages WHERE session_id=?')
        .get(value.logicalWorkSessionId) as { count: number }
      if (count.count >= 1000) {
        throw new Error('PeerMailbox session limit reached')
      }
      const envelope: PeerMessage = {
        ...value,
        fromWorkItemId: trustedSenderItemId,
        messageId: randomUUID(),
        createdAt: new Date().toISOString(),
        payload: redactValue(value.payload) as Record<string, unknown>
      }
      this.store.native.db
        .prepare(
          'INSERT INTO control_peer_messages (id,session_id,recipient_id,envelope) VALUES (?,?,?,?)'
        )
        .run(
          envelope.messageId,
          envelope.logicalWorkSessionId,
          envelope.toWorkItemId,
          JSON.stringify(envelope)
        )
      this.store.event(from, 'MESSAGE_SENT', {
        messageId: envelope.messageId,
        toWorkItemId: envelope.toWorkItemId,
        type: envelope.type
      })
      return envelope
    })
  }

  inbox(trustedRecipientItemId: string, afterMessageId?: string): PeerMessage[] {
    this.store.item(trustedRecipientItemId)
    let afterRow = 0
    if (afterMessageId) {
      const row = this.store.native.db
        .prepare('SELECT rowid FROM control_peer_messages WHERE id=? AND recipient_id=?')
        .get(afterMessageId, trustedRecipientItemId) as { rowid: number } | undefined
      if (!row) {
        throw new Error('Mailbox cursor belongs to another recipient or is missing')
      }
      afterRow = row.rowid
    }
    return (
      this.store.native.db
        .prepare(
          'SELECT envelope FROM control_peer_messages WHERE recipient_id=? AND rowid>? ORDER BY rowid LIMIT 100'
        )
        .all(trustedRecipientItemId, afterRow) as { envelope: string }[]
    ).map((row) => JSON.parse(row.envelope) as PeerMessage)
  }
}
