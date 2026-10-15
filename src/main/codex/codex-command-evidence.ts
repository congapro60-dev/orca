import { z } from 'zod'
import type { CommandEvidence } from '../../shared/control-evidence-contract'
import { redactString } from '../observability/redactor'

export const CodexCommandsSchema = z
  .array(
    z
      .object({
        itemId: z.string().min(1).max(256),
        command: z.string().max(2048),
        exitCode: z.number().int().refine(Number.isSafeInteger).nullable(),
        status: z.string().max(80)
      })
      .strict()
  )
  .max(64)

export function sanitizedCodexCommands(commands: CommandEvidence[]): CommandEvidence[] {
  return CodexCommandsSchema.parse(
    commands.map((command) => ({
      ...command,
      command: redactString(command.command).slice(0, 2048),
      status: redactString(command.status).slice(0, 80)
    }))
  )
}
