import type { CodexRuntimeReceipt } from '../../shared/codex-runtime-contract'
import { redactString } from '../observability/redactor'

export class CodexRuntimeTurnEvents {
  private readonly completed = new Map<string, Record<string, unknown>>()
  private readonly finalMessages = new Map<string, string>()
  private finish!: (turn: Record<string, unknown>) => void
  private readonly finished = new Promise<Record<string, unknown>>((resolve) => {
    this.finish = resolve
  })

  constructor(
    private readonly receipt: CodexRuntimeReceipt,
    private readonly progress: (method: string, itemType?: string) => void
  ) {}

  accept(method: string, value: unknown): void {
    if (
      !['item/started', 'item/completed', 'turn/started', 'turn/completed', 'error'].includes(
        method
      )
    ) {
      return
    }
    if (!value || typeof value !== 'object') {
      return
    }
    const params = value as Record<string, unknown>
    if (!this.receipt.threadId || params.threadId !== this.receipt.threadId) {
      return
    }
    const item = params.item as Record<string, unknown> | undefined
    this.progress(method, typeof item?.type === 'string' ? item.type : undefined)
    if (
      method === 'item/completed' &&
      typeof params.turnId === 'string' &&
      (!this.receipt.turnId || params.turnId === this.receipt.turnId) &&
      item?.type === 'agentMessage' &&
      item.phase !== 'commentary' &&
      typeof item.text === 'string'
    ) {
      if (item.text.length > 128000) {
        throw new Error('Codex result exceeds bounded output')
      }
      if (this.finalMessages.size >= 8 && !this.finalMessages.has(params.turnId)) {
        throw new Error('Unexpected Codex turn count')
      }
      this.finalMessages.set(params.turnId, redactString(item.text))
    }
    if (method === 'turn/completed' && params.turn && typeof params.turn === 'object') {
      const turn = params.turn as Record<string, unknown>
      if (typeof turn.id !== 'string') {
        return
      }
      if (this.completed.size >= 8) {
        throw new Error('Unexpected Codex turn count')
      }
      this.completed.set(turn.id, turn)
      if (turn.id === this.receipt.turnId) {
        this.finish(turn)
      }
    }
  }

  wait(): Promise<Record<string, unknown>> {
    const existing = this.completed.get(this.receipt.turnId ?? '')
    return existing ? Promise.resolve(existing) : this.finished
  }

  resultText(): string {
    return this.finalMessages.get(this.receipt.turnId ?? '') ?? ''
  }
}
