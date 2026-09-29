import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import type { RuntimeClient } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

type Flags = Map<string, string | boolean>
async function runAuthority(flags: Flags, cwd: string, client: RuntimeClient) {
  return {
    run: getRequiredStringFlag(flags, 'run'),
    from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
  }
}

export const ORCHESTRATION_CODEX_HANDLERS: Record<string, CommandHandler> = {
  'orchestration codex-start': async ({ flags, client, cwd, json }) => {
    const authority = await runAuthority(flags, cwd, client)
    const started = await callOrchestrationMutation<{
      execution: { executionId: string; dispatchId: string; status: string }
    }>(client, flags, 'orchestration.codexStartV1', {
      ...authority,
      task: getRequiredStringFlag(flags, 'task'),
      permissionMode: 'READ_ONLY',
      ...(getOptionalStringFlag(flags, 'model')
        ? { requestedModel: getOptionalStringFlag(flags, 'model') }
        : {}),
      ...(getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms')
        ? { timeoutMs: getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms') }
        : {})
    })
    printResult(
      started,
      json,
      (row) =>
        `Codex execution ${row.execution.executionId} [${row.execution.status}] Dispatch ${row.execution.dispatchId}`
    )
  },
  'orchestration codex-show': async ({ flags, client, json }) => {
    const response = await client.call<{
      execution: { executionId: string; status: string; result: string | null }
    }>('orchestration.codexShowV1', { executionId: getRequiredStringFlag(flags, 'execution') })
    printResult(
      response,
      json,
      (row) =>
        `Codex execution ${row.execution.executionId} [${row.execution.status}]\n${row.execution.result ?? ''}`
    )
  },
  'orchestration codex-events': async ({ flags, client, json }) => {
    const response = await client.call<{ events: { sequence: number; method: string }[] }>(
      'orchestration.codexEventsV1',
      {
        executionId: getRequiredStringFlag(flags, 'execution'),
        ...(flags.has('after') ? { after: getOptionalNonNegativeIntegerFlag(flags, 'after') } : {})
      }
    )
    printResult(response, json, (row) =>
      row.events.map((event) => `${event.sequence}: ${event.method}`).join('\n')
    )
  },
  'orchestration codex-cancel': async ({ flags, client, cwd, json }) => {
    const authority = await runAuthority(flags, cwd, client)
    const response = await callOrchestrationMutation<{
      execution: { executionId: string; status: string }
    }>(client, flags, 'orchestration.codexCancelV1', {
      ...authority,
      executionId: getRequiredStringFlag(flags, 'execution')
    })
    printResult(
      response,
      json,
      (row) => `Codex execution ${row.execution.executionId} [${row.execution.status}]`
    )
  }
}
