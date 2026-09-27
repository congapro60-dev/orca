import { z } from 'zod'
import { WorkerStartParams } from './orchestration-worker-start-schema'

export const WorkerPermissionMode = z.enum(['READ_ONLY', 'WORKSPACE_WRITE', 'FULL_ACCESS'])
export type WorkerPermissionMode = z.infer<typeof WorkerPermissionMode>

export const WorkerStartWithPermissionParams = WorkerStartParams.extend({
  permissionMode: WorkerPermissionMode
})

export type WorkerStartWithPermissionInput = z.infer<typeof WorkerStartWithPermissionParams>
