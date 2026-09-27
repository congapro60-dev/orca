import { repoIsRemote } from '../../../../shared/agent-launch-remote'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerStartWithPermissionInput } from './orchestration-worker-start-permission-schema'

export function validateReadOnlyWorkerStartRequest(
  params: WorkerStartWithPermissionInput,
  runtime: Pick<OrcaRuntimeService, 'validateOrchestrationReadOnlyCodexLauncher'>
): void {
  if (params.permissionMode !== 'READ_ONLY') {
    throw new OrchestrationError(
      'capability_unsupported',
      'WORKSPACE_WRITE and FULL_ACCESS worker permission modes are not implemented.'
    )
  }
  if (params.on || params.terminal || (params.worktree && params.worktree !== 'current')) {
    throw new OrchestrationError(
      'invalid_placement',
      'READ_ONLY requires a new local Codex terminal on the coordinator current worktree.'
    )
  }
  if (
    params.name ||
    params.repo ||
    params.baseBranch ||
    params.displayName ||
    params.comment ||
    params.setup
  ) {
    throw new OrchestrationError('invalid_argument', 'READ_ONLY cannot create a worktree or run setup.')
  }
  if (params.agent !== 'codex' || params.model || params.effort) {
    throw new OrchestrationError(
      'invalid_argument',
      'READ_ONLY currently requires agent=codex without model or effort overrides.'
    )
  }
  runtime.validateOrchestrationReadOnlyCodexLauncher()
}

export async function assertReadOnlyWorkerIsLocal(
  runtime: Pick<OrcaRuntimeService, 'showRepo'>,
  repoId: string,
  permissionMode?: string
): Promise<void> {
  if (permissionMode !== 'READ_ONLY') {
    return
  }
  const repo = await runtime.showRepo(`id:${repoId}`)
  if (repoIsRemote(repo)) {
    throw new OrchestrationError('invalid_placement', 'READ_ONLY cannot launch on a remote workspace.')
  }
}
