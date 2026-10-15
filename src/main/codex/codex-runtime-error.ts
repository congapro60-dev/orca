import { redactString } from '../observability/redactor'

export function codexRuntimeError(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error)).slice(0, 2000)
}

export function codexTurnError(turn: Record<string, unknown>): string {
  if (turn.status !== 'failed') {
    return 'Codex did not return a complete result'
  }
  const detail = turn.error as { message?: unknown } | null
  return codexRuntimeError(
    typeof detail?.message === 'string' ? detail.message : 'Codex reported a failed turn'
  )
}
