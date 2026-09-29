import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexRuntimeMcpOverrides } from './codex-runtime-mcp-overrides'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function profile(text: string) {
  const home = mkdtempSync(join(tmpdir(), 'orca-codex-mcp-'))
  roots.push(home)
  writeFileSync(join(home, 'config.toml'), text)
  return home
}

describe('per-process Codex MCP isolation', () => {
  it('constructs disabled placeholder transports from names only, never secret values', async () => {
    const home = profile(
      `[mcp_servers.node_repl]\ncommand = "private path"\n[mcp_servers.node_repl.env]\nAPI_KEY = "do-not-copy"\n[mcp_servers."claude-bridge"]\nargs = ["hidden"]\n`
    )
    const args = await codexRuntimeMcpOverrides(home)
    expect(args.names).toEqual(['claude-bridge', 'node_repl'])
    expect(args.args).toEqual([
      '-c',
      'mcp_servers.claude-bridge={command="__orca_disabled_mcp__",enabled=false}',
      '-c',
      'mcp_servers.node_repl={command="__orca_disabled_mcp__",enabled=false}'
    ])
    expect(JSON.stringify(args)).not.toMatch(/do-not-copy|private path|hidden/)
  })

  it('fails closed for names that cannot be encoded safely', async () => {
    const home = profile('[mcp_servers."unsafe.name"]\ncommand = "x"\n')
    await expect(codexRuntimeMcpOverrides(home)).rejects.toThrow(/Unsupported/)
  })

  it('returns no overrides when the dedicated profile has no config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-codex-mcp-'))
    roots.push(home)
    expect(await codexRuntimeMcpOverrides(home)).toEqual({ names: [], args: [] })
  })
})
