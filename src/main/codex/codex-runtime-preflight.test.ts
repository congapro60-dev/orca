import { describe, expect, it } from 'vitest'
import { codexRuntimePreflight, verifyCodexRuntimeTools } from './codex-runtime-preflight'
import type { CodexAppServerRpc } from './codex-app-server-session'

function rpc(
  states: { name: string; runtimeStatus: string | null }[],
  config = { model_provider: null, openai_base_url: null, model_providers: {} } as Record<
    string,
    unknown
  >
): CodexAppServerRpc {
  return {
    notify: () => {},
    request: async (method) => {
      if (method === 'account/read') {
        return { account: { type: 'chatgpt' } }
      }
      if (method === 'hooks/list') {
        return { data: [{ hooks: [] }] }
      }
      if (method === 'config/read') {
        return { config }
      }
      if (method === 'mcpServerStatus/list') {
        return { data: states, nextCursor: null }
      }
      throw new Error('Unexpected method')
    }
  }
}

describe('installed Codex MCP inventory semantics', () => {
  it('classifies revoked managed ChatGPT auth before config or tool access', async () => {
    const calls: string[] = []
    const client: CodexAppServerRpc = {
      notify: () => {},
      request: async (method) => {
        calls.push(method)
        throw new Error('workspace routing discovery unauthorized (401)')
      }
    }
    await expect(codexRuntimePreflight(client, '/repo', [])).rejects.toThrow(
      /Reauthenticate through supported Codex login/
    )
    expect(calls).toEqual(['account/read'])
  })

  it('does not mislabel a transport outage as an authentication failure', async () => {
    const client: CodexAppServerRpc = {
      notify: () => {},
      request: async () => {
        throw new Error('app-server transport disconnected')
      }
    }
    await expect(codexRuntimePreflight(client, '/repo', [])).rejects.toThrow(
      'app-server transport disconnected'
    )
  })

  it('rejects a project-layer MCP before thread startup', async () => {
    await expect(
      codexRuntimePreflight(
        rpc([], { mcp_servers: { project_tool: { command: 'never-run' } } }),
        '/repo',
        []
      )
    ).rejects.toThrow(/Project MCP server/)
  })

  it.each([
    { model_provider: 'paid_api' },
    { openai_base_url: 'https://unapproved.example' },
    { model_providers: { openai: { base_url: 'https://unapproved.example' } } }
  ])('refuses custom provider routing in the effective workspace config', async (config) => {
    await expect(codexRuntimePreflight(rpc([], config), '/repo', [])).rejects.toThrow(
      /Custom provider or endpoint/
    )
  })
  it('accepts a null pre-thread state only for names disabled by process argv', async () => {
    const config = await codexRuntimePreflight(
      rpc([{ name: 'bridge', runtimeStatus: null }]),
      '/repo',
      ['bridge']
    )
    expect(config).not.toHaveProperty('mcp_servers')
    expect(config).toMatchObject({ features: { apps: false, plugins: false } })
  })

  it('rejects an unoverridden server even before a thread exists', async () => {
    await expect(
      codexRuntimePreflight(rpc([{ name: 'new', runtimeStatus: null }]), '/repo', [])
    ).rejects.toThrow(/disable override/)
  })

  it.each([null, 'starting', 'connected', 'failed', 'notStarted'])(
    'refuses unproven thread state %s before submitting work',
    async (runtimeStatus) => {
      await expect(
        verifyCodexRuntimeTools(rpc([{ name: 'bridge', runtimeStatus }]), 'thread', ['bridge'])
      ).rejects.toThrow(/not proven disabled/)
    }
  )

  it('accepts only explicitly disabled thread servers', async () => {
    await expect(
      verifyCodexRuntimeTools(rpc([{ name: 'bridge', runtimeStatus: 'disabled' }]), 'thread', [
        'bridge'
      ])
    ).resolves.toBeUndefined()
  })
})
