import { z } from 'zod'
import type { CodexAppServerRpc } from './codex-app-server-session'

const ServerPage = z.object({
  data: z.array(
    z.object({
      name: z.string().min(1).max(200),
      runtimeStatus: z.string().nullable().optional()
    })
  ),
  nextCursor: z.string().nullable()
})

async function assertMcpInventory(
  rpc: CodexAppServerRpc,
  expectedNames: readonly string[],
  threadId?: string
): Promise<void> {
  const expected = new Set(expectedNames)
  let cursor: string | null = null
  for (let page = 0; page < 10; page++) {
    const result = ServerPage.parse(
      await rpc.request('mcpServerStatus/list', {
        ...(threadId ? { threadId } : {}),
        cursor,
        limit: 100
      })
    )
    const unexpected = result.data.find((entry) => !expected.has(entry.name))
    if (unexpected) {
      throw new Error(`MCP server ${unexpected.name} lacks a process-scoped disable override`)
    }
    const active = threadId
      ? result.data.find((entry) => entry.runtimeStatus !== 'disabled')
      : undefined
    if (active) {
      throw new Error(`MCP server ${active.name} is not proven disabled in the Codex thread`)
    }
    if (result.nextCursor === null) {
      return
    }
    if (result.nextCursor === cursor) {
      throw new Error('MCP inventory cursor did not advance')
    }
    cursor = result.nextCursor
  }
  throw new Error('MCP inventory exceeds the bounded runtime preflight')
}

export async function codexRuntimePreflight(
  rpc: CodexAppServerRpc,
  worktree: string,
  expectedMcpNames: readonly string[]
): Promise<Record<string, unknown>> {
  let accountResponse: unknown
  try {
    accountResponse = await rpc.request('account/read', { refreshToken: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/\b401\b|unauthorized|token_revoked|refresh token (?:was )?revoked/i.test(message)) {
      throw new Error(
        'Codex ChatGPT sign-in is unavailable in the dedicated ORCA profile. Reauthenticate through supported Codex login; API-key fallback is disabled.'
      )
    }
    throw error
  }
  const account = z
    .object({ account: z.object({ type: z.literal('chatgpt') }) })
    .safeParse(accountResponse)
  if (!account.success) {
    throw new Error('Codex subscription sign-in required; API-key fallback forbidden')
  }
  const effective = z
    .object({
      config: z.object({
        mcp_servers: z.record(z.string(), z.unknown()).optional(),
        model_provider: z.string().nullish(),
        openai_base_url: z.unknown().optional(),
        model_providers: z.record(z.string(), z.unknown()).nullish()
      })
    })
    .parse(await rpc.request('config/read', { cwd: worktree, includeLayers: false }))
  if (
    (effective.config.model_provider && effective.config.model_provider !== 'openai') ||
    effective.config.openai_base_url != null ||
    effective.config.model_providers?.openai != null
  ) {
    throw new Error(
      'Custom provider or endpoint is forbidden for subscription-only Alpha execution'
    )
  }
  const missing = Object.keys(effective.config.mcp_servers ?? {}).find(
    (name) => !expectedMcpNames.includes(name)
  )
  if (missing) {
    throw new Error(`Project MCP server ${missing} lacks a process-scoped disable override`)
  }
  const listing = z
    .object({
      data: z.array(
        z.object({
          hooks: z.array(
            z.object({
              enabled: z.boolean(),
              trustStatus: z.string()
            })
          )
        })
      )
    })
    .parse(await rpc.request('hooks/list', { cwds: [worktree] }))
  if (
    listing.data.some((entry) =>
      entry.hooks.some((hook) => hook.enabled && hook.trustStatus !== 'trusted')
    )
  ) {
    throw new Error('Codex profile has enabled untrusted hooks; automatic trust is forbidden')
  }
  await assertMcpInventory(rpc, expectedMcpNames)
  return {
    features: { apps: false, plugins: false, multi_agent: false, multi_agent_v2: false },
    web_search: 'disabled'
  }
}

export async function verifyCodexRuntimeTools(
  rpc: CodexAppServerRpc,
  threadId: string,
  expectedMcpNames: readonly string[]
): Promise<void> {
  await assertMcpInventory(rpc, expectedMcpNames, threadId)
}
