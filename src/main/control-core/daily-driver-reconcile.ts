import type { OrchestrationDb } from '../runtime/orchestration/db'
import { ControlEvidenceStore } from './control-evidence-store'
import { ControlWorkStore } from './control-work-store'
import { captureWorkspaceCheckpoint } from './workspace-checkpoint'
import type { ControlCoreFacade } from './control-core-facade'
import type { WorkspaceCheckpoint } from '../../shared/control-evidence-contract'

export async function reconcileDailyDriver(
  core: ControlCoreFacade,
  native: OrchestrationDb,
  itemId: string,
  sessionId: string
): Promise<void> {
  const session = core.openSession(sessionId).session
  const evidence = new ControlEvidenceStore(new ControlWorkStore(native))
  let observed: WorkspaceCheckpoint | null = null
  try {
    observed = evidence.checkpoint(itemId, await captureWorkspaceCheckpoint(session.worktree))
  } catch {
    observed = null
  }
  core.reconcileResume({
    workItemId: itemId,
    sourceExecutionId: core.item(itemId).executionId,
    observed
  })
}
