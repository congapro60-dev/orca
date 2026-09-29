import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const ORCHESTRATION_CODEX_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'codex-start'],
    summary: 'Dispatch an existing native Task through programmatic Codex READ_ONLY',
    usage:
      'orca orchestration codex-start --task <task_id> --run <run_id> [--from <handle>] [--model <id>] [--timeout-ms <n>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'run', 'from', 'model', 'timeout-ms', 'retry-request'],
    notes: [
      'Orca owns Run/Task/Dispatch; Codex is an execution. Requires local workspace and managed subscription profile. No TUI or FULL_ACCESS fallback.'
    ]
  },
  {
    path: ['orchestration', 'codex-show'],
    summary: 'Show native state and result of a programmatic Codex execution',
    usage: 'orca orchestration codex-show --execution <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'execution']
  },
  {
    path: ['orchestration', 'codex-events'],
    summary: 'Read bounded structured progress from native Orca',
    usage: 'orca orchestration codex-events --execution <id> [--after <sequence>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'execution', 'after']
  },
  {
    path: ['orchestration', 'codex-cancel'],
    summary: 'Request cancellation of a Codex execution in the bound Run',
    usage:
      'orca orchestration codex-cancel --execution <id> --run <run_id> [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'execution', 'run', 'from', 'retry-request']
  }
]
