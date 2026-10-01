import { z } from 'zod'
import { repoIsRemote } from '../../../../shared/agent-launch-remote'
import { resolveCodexRuntimeExecutable } from '../../../codex/codex-runtime-installation'
import { getOrcaManagedCodexHomePath } from '../../../codex/codex-home-paths'
import { CodexExecutionSupervisor } from '../../orchestration/codex-execution-supervisor'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, type RpcMethod } from '../core'
import { resolveRunScope } from './orchestration-run-scope'

const Start = z
  .object({
    task: z.string().min(1),
    run: z.string().min(1),
    from: z.string().min(1),
    permissionMode: z.literal('READ_ONLY'),
    requestedModel: z.string().trim().min(1).max(128).optional(),
    timeoutMs: z.number().int().min(1000).max(600000).optional()
  })
  .strict()
const Show = z.object({ executionId: z.string().uuid() }).strict()
const Events = Show.extend({ after: z.number().int().min(0).optional() }).strict()
const Cancel = Show.extend({ run: z.string().min(1), from: z.string().min(1) }).strict()

const supervisors = new WeakMap<OrcaRuntimeService, CodexExecutionSupervisor>()
export function getCodexExecutionSupervisor(runtime: OrcaRuntimeService): CodexExecutionSupervisor {
  let current = supervisors.get(runtime)
  if (!current) {
    current = new CodexExecutionSupervisor(runtime.getOrchestrationDb(), runtime.getRuntimeId())
    supervisors.set(runtime, current)
  }
  return current
}

export const ORCHESTRATION_CODEX_EXECUTION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.codexStartV1',
    params: Start,
    handler: async (
      params,
      { runtime, orchestrationMutation, orchestrationCompatibilityEvidence }
    ) => {
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const db = runtime.getOrchestrationDb()
      const task = db.getTask(params.task)
      if (!task || task.run_id !== run.id || task.status !== 'ready') {
        throw new OrchestrationError(
          'task_not_startable',
          'Only a ready Task in the bound Run may dispatch Codex.'
        )
      }
      const terminal = await runtime.showTerminal(params.from)
      const workspace = await runtime.showManagedTerminalWorkspace(`id:${terminal.worktreeId}`)
      const repo = await runtime.showRepo(`id:${workspace.repoId}`)
      if (repoIsRemote(repo)) {
        throw new OrchestrationError(
          'invalid_placement',
          'Programmatic Codex V0 requires a local workspace.'
        )
      }
      const row = await getCodexExecutionSupervisor(runtime).start(
        task.id,
        {
          worktree: workspace.path,
          prompt: task.spec,
          permissionMode: 'READ_ONLY',
          approvalPolicy: 'never',
          executablePath: resolveCodexRuntimeExecutable(),
          codexHome: getOrcaManagedCodexHomePath(),
          ...(params.requestedModel ? { requestedModel: params.requestedModel } : {}),
          ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {})
        },
        orchestrationMutation
      )
      return { execution: row }
    }
  }),
  defineMethod({
    name: 'orchestration.codexShowV1',
    params: Show,
    handler: ({ executionId }, { runtime }) => ({
      execution: getCodexExecutionSupervisor(runtime).get(executionId)
    })
  }),
  defineMethod({
    name: 'orchestration.codexEventsV1',
    params: Events,
    handler: ({ executionId, after }, { runtime }) => ({
      events: getCodexExecutionSupervisor(runtime).store.events(executionId, after)
    })
  }),
  defineMethod({
    name: 'orchestration.codexCancelV1',
    params: Cancel,
    handler: async (
      { executionId, run, from },
      { runtime, orchestrationCompatibilityEvidence }
    ) => {
      const scope = resolveRunScope(runtime, {
        runId: run,
        callerTerminalHandle: from,
        requireCurrentConsumer: true,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const owner = getCodexExecutionSupervisor(runtime)
      if (owner.get(executionId).runId !== scope.id) {
        throw new OrchestrationError('consumer_fenced', 'Execution belongs to another Run.')
      }
      await owner.cancel(executionId)
      return { execution: owner.get(executionId) }
    }
  })
]
