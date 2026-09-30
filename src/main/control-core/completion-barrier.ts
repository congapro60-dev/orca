import type { WorkItem } from '../../shared/control-core-contract'

export function completionBarrier(
  items: readonly WorkItem[],
  rootId: string
): { ready: boolean; pendingIds: string[] } {
  const root = items.find((item) => item.workItemId === rootId)
  if (!root || root.parentWorkItemId !== null) {
    throw new Error('CompletionBarrier requires a graph root')
  }
  const children = items.filter((item) => item.workItemId !== rootId)
  if (!children.length) {
    return { ready: false, pendingIds: [rootId] }
  }
  const byId = new Map(items.map((item) => [item.workItemId, item]))
  for (const item of children) {
    const seen = new Set([item.workItemId])
    let parent = item.parentWorkItemId
    while (parent && parent !== rootId) {
      if (seen.has(parent)) {
        throw new Error('WorkGraph contains a parent cycle')
      }
      seen.add(parent)
      parent = byId.get(parent)?.parentWorkItemId ?? null
    }
    if (parent !== rootId || item.logicalWorkSessionId !== root.logicalWorkSessionId) {
      throw new Error('WorkGraph contains a disconnected or foreign item')
    }
  }
  const pendingIds = children
    .filter(
      (item) =>
        item.status !== 'VERIFIED' ||
        item.dependsOn.some((id) => byId.get(id)?.status !== 'VERIFIED')
    )
    .map((item) => item.workItemId)
  return { ready: pendingIds.length === 0, pendingIds }
}
