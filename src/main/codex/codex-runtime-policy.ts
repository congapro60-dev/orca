import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { CodexRuntimeRequest } from '../../shared/codex-runtime-contract'
import { runProcess } from '../../shared/child-process/run-process'

export const CodexRuntimeRequestSchema = z
  .object({
    worktree: z.string().min(1),
    prompt: z.string().trim().min(1).max(32000),
    permissionMode: z.literal('READ_ONLY'),
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
    'userprofile',
    'home',
    'homedrive',
    'homepath',
    'appdata',
    'localappdata',
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
  sandbox: z.object({ type: z.literal('readOnly'), networkAccess: z.literal(false) }),
  approvalPolicy: z.literal('never')
})

export const TurnReceiptSchema = z.object({ turn: z.object({ id: z.string().min(1) }) })
