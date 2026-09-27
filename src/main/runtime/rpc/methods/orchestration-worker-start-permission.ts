import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { WorkerStartWithPermissionParams } from './orchestration-worker-start-permission-schema'

export const ORCHESTRATION_WORKER_START_PERMISSION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStartWithPermissionV1',
    params: WorkerStartWithPermissionParams,
    handler: () => {
      // The interactive TUI path has not proven sandbox or hook-review behavior.
      throw new OrchestrationError(
        'capability_unsupported',
        'Permission-scoped TUI worker start is unavailable; use the programmatic Codex runtime.'
      )
    }
  })
]
