import { createReadStream, existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, relative, sep } from 'node:path'

const CONFIG_LIMIT = 1024 * 1024
const SERVER_LIMIT = 64
const HEADER = /^\[mcp_servers\.(?:"([A-Za-z0-9_-]+)"|([A-Za-z0-9_-]+))(?:\.[A-Za-z0-9_-]+)?\]$/

/** Extract section names only; do not retain values, commands or credentials. */
export async function codexRuntimeMcpOverrides(
  codexHome: string
): Promise<{ names: string[]; args: string[] }> {
  const config = join(codexHome, 'config.toml')
  if (!existsSync(config)) {
    return { names: [], args: [] }
  }
  const root = realpathSync(codexHome)
  const file = realpathSync(config)
  const rel = relative(root, file)
  if (
    lstatSync(config).isSymbolicLink() ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    !statSync(config).isFile()
  ) {
    throw new Error('Codex profile configuration escapes the dedicated home')
  }
  if (statSync(config).size > CONFIG_LIMIT) {
    throw new Error('Codex profile configuration is too large to inspect safely')
  }
  const names = new Set<string>()
  const reader = createInterface({
    input: createReadStream(config, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  for await (const line of reader) {
    if (!line.startsWith('[mcp_servers.')) {
      continue
    }
    const match = HEADER.exec(line.trim())
    if (!match) {
      throw new Error('Unsupported MCP section name in the dedicated Codex profile')
    }
    names.add(match[1] ?? match[2])
    if (names.size > SERVER_LIMIT) {
      throw new Error('Codex profile exceeds the MCP preflight limit')
    }
  }
  const sorted = [...names].sort()
  return {
    names: sorted,
    args: sorted.flatMap((name) => [
      '-c',
      `mcp_servers.${name}={command="__orca_disabled_mcp__",enabled=false}`
    ])
  }
}
