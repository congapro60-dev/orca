import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, sep } from 'node:path'
import { z } from 'zod'
import type { CodexRuntimeRequest } from '../../shared/codex-runtime-contract'
import { runProcess } from '../../shared/child-process/run-process'

export const CodexRuntimeRequestSchema = z
  .object({
    worktree: z.string().min(1),
    prompt: z.string().trim().min(1).max(32000),
    permissionMode: z.enum(['READ_ONLY', 'WORKSPACE_WRITE']),
    approvalPolicy: z.literal('never'),
    requestedModel: z.string().trim().min(1).max(128).optional(),
    executablePath: z.string().min(1),
    codexHome: z.string().min(1),
    timeoutMs: z.number().int().min(1000).max(600000).optional()
  })
  .strict()

export type PreparedCodexRuntime = {
  executable: string
  version: string
  worktree: string
  codexHome: string
}

export function codexRuntimeEnvironment(codexHome: string): Record<string, string> {
  const names = new Set([
    'path',
    'pathext',
    'comspec',
    'systemroot',
    'windir',
    'temp',
    'tmp',
    // User-scoped locations are replaced with the managed runtime home below.
    // Inheriting the owner's profile would expose standard credential paths to
    // a workspace-write child even when CODEX_HOME is isolated.
    'programfiles',
    'programfiles(x86)',
    'allusersprofile',
    'lang',
    'lc_all',
    'tz',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'ssl_cert_file',
    'ssl_cert_dir'
  ])
  const env: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toLowerCase()
    if (value !== undefined && names.has(name) && !seen.has(name)) {
      env[key] = value
      seen.add(name)
    }
  }
  env.CODEX_HOME = codexHome
  if (isAbsolute(codexHome)) {
    const parsed = parse(codexHome)
    const relativeHome = codexHome.slice(parsed.root.length) || sep
    env.USERPROFILE = codexHome
    env.HOME = codexHome
    env.HOMEDRIVE = parsed.root.replace(/[\\/]$/, '')
    env.HOMEPATH = relativeHome.startsWith(sep) ? relativeHome : `${sep}${relativeHome}`
    env.APPDATA = join(codexHome, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(codexHome, 'AppData', 'Local')
  }
  return env
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(
    process.platform === 'win32' ? root.toLowerCase() : root,
    process.platform === 'win32' ? candidate.toLowerCase() : candidate
  )
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export async function prepareCodexRuntime(
  request: CodexRuntimeRequest
): Promise<PreparedCodexRuntime> {
  for (const value of [request.worktree, request.codexHome, request.executablePath]) {
    if (!isAbsolute(value)) {
      throw new Error('Codex runtime requires absolute host-resolved paths')
    }
  }
  const worktree = realpathSync(request.worktree)
  const codexHome = realpathSync(request.codexHome)
  const executable = realpathSync(request.executablePath)
  if (!statSync(worktree).isDirectory() || !statSync(codexHome).isDirectory()) {
    throw new Error('Codex workspace and profile must be directories')
  }
  if (!statSync(executable).isFile() || inside(worktree, executable)) {
    throw new Error('Codex executable must be installed outside the workspace')
  }
  if (process.platform === 'win32' && !executable.toLowerCase().endsWith('.exe')) {
    throw new Error('Codex runtime requires a resolved native Windows executable, not a shell shim')
  }
  if (inside(worktree, codexHome) || inside(codexHome, worktree)) {
    throw new Error('Codex profile must be separate from the workspace')
  }
  const globalPath = join(homedir(), '.codex')
  const globalHome = existsSync(globalPath) ? realpathSync(globalPath) : globalPath
  if (inside(worktree, globalHome) || inside(globalHome, worktree)) {
    throw new Error('Codex workspace must not overlap global configuration')
  }
  if (inside(globalHome, codexHome) || inside(codexHome, globalHome)) {
    throw new Error('Codex runtime requires a dedicated profile, not global CODEX_HOME')
  }
  const probe = await runProcess({
    program: executable,
    args: ['--version'],
    cwd: codexHome,
    env: codexRuntimeEnvironment(codexHome),
    timeoutMs: 5000,
    maxOutputBytes: 1024
  })
  if (probe.code !== 0 || !/^codex-cli [\w.+-]+\s*$/.test(probe.stdout.trim())) {
    throw new Error('Could not positively identify installed Codex executable/version')
  }
  return { executable, version: probe.stdout.trim(), worktree, codexHome }
}

export const ThreadReceiptSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
  cwd: z.string(),
  model: z.string().optional(),
  sandbox: z.discriminatedUnion('type', [
    z.object({ type: z.literal('readOnly'), networkAccess: z.literal(false) }),
    z.object({
      type: z.literal('workspaceWrite'),
      networkAccess: z.literal(false),
      writableRoots: z.array(z.string().refine(isAbsolute)).length(1),
      excludeTmpdirEnvVar: z.literal(true),
      excludeSlashTmp: z.literal(true)
    })
  ]),
  approvalPolicy: z.literal('never')
})

export const TurnReceiptSchema = z.object({ turn: z.object({ id: z.string().min(1) }) })

export function codexSandboxPolicy(
  permissionMode: CodexRuntimeRequest['permissionMode'],
  worktree: string
) {
  return permissionMode === 'WORKSPACE_WRITE'
    ? {
        type: 'workspaceWrite' as const,
        networkAccess: false as const,
        writableRoots: [worktree],
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true
      }
    : { type: 'readOnly' as const, networkAccess: false as const }
}

export function codexSandboxConfig(
  permissionMode: CodexRuntimeRequest['permissionMode'],
  worktree: string
) {
  return permissionMode === 'WORKSPACE_WRITE'
    ? {
        sandbox_workspace_write: {
          writable_roots: [worktree],
          network_access: false,
          exclude_tmpdir_env_var: true,
          exclude_slash_tmp: true
        }
      }
    : {}
}

export function checkedCodexThread(
  value: unknown,
  permissionMode: CodexRuntimeRequest['permissionMode'],
  worktree: string
) {
  const thread = ThreadReceiptSchema.parse(value)
  if (relative(worktree, thread.cwd) !== '') {
    throw new Error('Codex returned a different workspace')
  }
  if (
    thread.sandbox.type !== codexSandboxPolicy(permissionMode, worktree).type ||
    (thread.sandbox.type === 'workspaceWrite' &&
      relative(worktree, thread.sandbox.writableRoots[0]!) !== '')
  ) {
    throw new Error('Codex returned a different sandbox permission or writable root')
  }
  return thread
}
