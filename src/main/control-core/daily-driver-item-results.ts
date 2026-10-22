import type { WorkItem } from '../../shared/control-core-contract'

type ExecutionLookup = { get: (executionId: string) => { result: string | null } | undefined }

/**
 * Runtime result per work item, so a conversation can render every answered turn.
 * A missing or unreadable execution record stays unknown instead of inventing a result.
 */
export function collectItemResults(
  supervisor: ExecutionLookup,
  items: readonly WorkItem[]
): Record<string, string> {
  const results: Record<string, string> = {}
  for (const row of items) {
    if (!row.executionId) {
      continue
    }
    try {
      const result = supervisor.get(row.executionId)?.result
      if (result) {
        results[row.workItemId] = result
      }
    } catch {
      // Unknown execution: report nothing rather than a fabricated answer.
    }
  }
  return results
}
