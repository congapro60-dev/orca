import { defineMethod, type RpcMethod } from '../core'
import { LegacyWorkerStartParams } from './orchestration-worker-start-schema'
import { startOrchestrationWorker } from './orchestration-workers'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: LegacyWorkerStartParams,
    handler: (params, context) => startOrchestrationWorker(params, context)
  })
]
