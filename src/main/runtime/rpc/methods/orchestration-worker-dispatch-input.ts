import type { OrcaRuntimeService } from '../../orca-runtime'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import type { WorkerEffect } from './orchestration-worker-topology'

export async function sendWorkerDispatchInput(args: {
  runtime: OrcaRuntimeService
  taskId: string
  taskSpec: string
  dispatchId: string
  coordinatorHandle: string
  workerHandle: string
  dispatchCapability: string
  canDispatchSubWorkers: boolean
  devMode?: boolean
  effects: WorkerEffect[]
}): Promise<void> {
  const preamble = buildDispatchPreamble({
    canDispatchSubWorkers: args.canDispatchSubWorkers,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: args.workerHandle,
    dispatchCapability: args.dispatchCapability,
    devMode: args.devMode,
    cliCommand: args.runtime.getTerminalOrchestrationCliCommand(args.workerHandle)
  })
  await args.runtime.sendTerminalAgentPrompt(args.workerHandle, preamble)
  args.effects.push({ kind: 'dispatch_input', role: 'agent', id: args.workerHandle, state: 'accepted' })
}
