import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { resolveCodexCommand } from '../../shared/node-cli-command-resolution'

/** Host-derived native executable only; never accept an RPC-supplied program path. */
export function resolveCodexRuntimeExecutable(
  options: {
    platform?: NodeJS.Platform
    pathEnv?: string
    localAppData?: string
  } = {}
): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    const command = resolveCodexCommand({ platform, pathEnv: options.pathEnv })
    if (!isAbsolute(command)) {
      throw new Error('Codex executable is not host-resolved')
    }
    return realpathSync(command)
  }
  const search = (options.pathEnv ?? process.env.Path ?? process.env.PATH ?? '')
    .split(platform === 'win32' ? ';' : delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, 'codex.exe'))
  const local =
    options.localAppData ?? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const desktopBin = join(local, 'OpenAI', 'Codex', 'bin')
  if (existsSync(desktopBin)) {
    const folders = readdirSync(desktopBin, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(desktopBin, entry.name, 'codex.exe'))
      .filter((path) => existsSync(path))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    search.push(...folders)
  }
  for (const candidate of search) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return realpathSync(candidate)
    }
  }
  throw new Error('No installed native Codex executable was found on this host')
}
