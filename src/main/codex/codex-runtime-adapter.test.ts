import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRuntimeAdapterV0 } from './codex-runtime-adapter'
import type { CodexAppServerInvocation, runCodexAppServerSession } from './codex-app-server-session'
import type { CodexRuntimeRequest } from '../../shared/codex-runtime-contract'

const request: CodexRuntimeRequest = {
  worktree: join(tmpdir(), 'test-repo'),
  codexHome: join(tmpdir(), 'test-profile'),
  executablePath: join(tmpdir(), 'codex.exe'),
  prompt: 'Inspect repo, no writes.',
  permissionMode: 'READ_ONLY',
  approvalPolicy: 'never'
}

type Scenario = {
  sandbox?: string
  sandboxFields?: Record<string, unknown>
  cwd?: string
  account?: string | null
  untrustedHook?: boolean
  threadMcp?: boolean
  text?: string
  terminal?: string
  hold?: boolean
  disconnect?: boolean
  progressCount?: number
}

function fixture(scenario: Scenario = {}) {
  let invocation!: CodexAppServerInvocation
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const emit = (method: string, params: unknown) => invocation.onNotification?.(method, params)
  const terminal = (status: string) => {
    emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status } })
  }
  const session: typeof runCodexAppServerSession = async (args, body) => {
    invocation = args
    args.signal?.throwIfAborted()
    return body({
      notify: () => {},
      request: async (method, params) => {
        calls.push({ method, params })
        if (method === 'account/read') {
          return {
            account: scenario.account === null ? null : { type: scenario.account ?? 'chatgpt' }
          }
        }
        if (method === 'hooks/list') {
          return {
            data: [
              { hooks: scenario.untrustedHook ? [{ enabled: true, trustStatus: 'untrusted' }] : [] }
            ]
          }
        }
        if (method === 'mcpServerStatus/list') {
          return {
            data:
              params?.threadId && scenario.threadMcp
                ? [{ name: 'unexpected', runtimeStatus: 'connected' }]
                : [],
            nextCursor: null
          }
        }
        if (method === 'config/read') {
          return { config: {} }
        }
        if (method === 'thread/start') {
          return {
            thread: { id: 'thread-1' },
            cwd: scenario.cwd ?? request.worktree,
            model: 'reported-model',
            sandbox: {
              type: scenario.sandbox ?? 'readOnly',
              networkAccess: false,
              ...(scenario.sandbox === 'workspaceWrite'
                ? {
                    writableRoots: [request.worktree],
                    excludeSlashTmp: true,
                    excludeTmpdirEnvVar: true
                  }
                : {}),
              ...scenario.sandboxFields
            },
            approvalPolicy: 'never'
          }
        }
        if (method === 'turn/start') {
          if (scenario.disconnect) {
            throw new Error('connection lost token=secret-value')
          }
          for (let i = 0; i < (scenario.progressCount ?? 0); i++) {
            emit('item/started', {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: { type: 'commandExecution', command: 'sensitive-command' }
            })
          }
          // Real servers may emit item/turn completion before the turn/start response.
          emit('item/completed', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', phase: 'final_answer', text: scenario.text ?? 'READY' }
          })
          if (!scenario.hold) {
            terminal(scenario.terminal ?? 'completed')
          }
          return { turn: { id: 'turn-1' } }
        }
        if (method === 'turn/interrupt') {
          terminal('interrupted')
          return {}
        }
        throw new Error(`Unexpected request ${method}`)
      }
    })
  }
  const prepare = vi.fn(async () => ({
    executable: request.executablePath,
    version: 'codex-cli test',
    worktree: request.worktree,
    codexHome: request.codexHome
  }))
  return {
    adapter: new CodexRuntimeAdapterV0({ prepare, session }),
    calls,
    prepare,
    emit,
    getInvocation: () => invocation
  }
}

describe('CodexRuntimeAdapterV0', () => {
  it('captures identity and an early structured result without claiming an actual model', async () => {
    const { adapter, calls, getInvocation } = fixture()
    const receipt = await adapter.start(request)
    const result = await adapter.result(receipt.executionId)
    expect(result.status).toBe('COMPLETED')
    expect(result.text).toBe('READY')
    expect(getInvocation().args).toContain('--config=model_provider="openai"')
    expect(result.receipt).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      resolvedModel: 'reported-model',
      actualModel: 'UNKNOWN_UNVERIFIED',
      effectiveSandbox: 'READ_ONLY'
    })
    expect(calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      approvalPolicy: 'never'
    })
    const snapshot = adapter.getStatus(receipt.executionId)
    snapshot.text = 'tampered'
    expect(adapter.getStatus(receipt.executionId).text).toBe('READY')
    adapter.release(receipt.executionId)
    expect(() => adapter.getStatus(receipt.executionId)).toThrow(/Unknown/)
  })

  it('maps WORKSPACE_WRITE to the bounded workspace sandbox', async () => {
    const { adapter, calls, getInvocation } = fixture({ sandbox: 'workspaceWrite' })
    const receipt = await adapter.start({ ...request, permissionMode: 'WORKSPACE_WRITE' })
    const result = await adapter.result(receipt.executionId)
    expect(result.status).toBe('COMPLETED')
    expect(getInvocation().args).toContain('--config=model_provider="openai"')
    expect(result.receipt.effectiveSandbox).toBe('WORKSPACE_WRITE')
    expect(calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
      sandbox: 'workspace-write',
      config: {
        sandbox_workspace_write: {
          writable_roots: [request.worktree],
          network_access: false,
          exclude_tmpdir_env_var: true,
          exclude_slash_tmp: true
        }
      }
    })
    expect(calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: {
        type: 'workspaceWrite',
        networkAccess: false,
        writableRoots: [request.worktree],
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true
      }
    })
  })

  it.each<Scenario>([
    { sandbox: 'readOnly' },
    { sandbox: 'workspaceWrite', sandboxFields: { writableRoots: [tmpdir()] } },
    { sandbox: 'workspaceWrite', sandboxFields: { writableRoots: [request.worktree, tmpdir()] } },
    { sandbox: 'workspaceWrite', sandboxFields: { writableRoots: [] } },
    { sandbox: 'workspaceWrite', sandboxFields: { writableRoots: ['relative'] } },
    { sandbox: 'workspaceWrite', sandboxFields: { networkAccess: true } },
    { sandbox: 'workspaceWrite', sandboxFields: { excludeTmpdirEnvVar: false } },
    { sandbox: 'workspaceWrite', sandboxFields: { excludeSlashTmp: undefined } }
  ])('refuses unproven WORKSPACE_WRITE policy before turn/start: %j', async (scenario) => {
    const { adapter, calls } = fixture(scenario)
    const receipt = await adapter.start({ ...request, permissionMode: 'WORKSPACE_WRITE' })
    const result = await adapter.result(receipt.executionId)
    expect(result.status).toBe('FAILED')
    expect(result.receipt.effectiveSandbox).toBe('UNKNOWN_UNVERIFIED')
    expect(calls.some((call) => call.method === 'turn/start')).toBe(false)
  })

  it.each<Scenario>([
    { sandbox: 'dangerFullAccess' },
    { sandbox: 'workspaceWrite' },
    { cwd: join(tmpdir(), 'wrong') },
    { account: 'apiKey' },
    { account: null },
    { untrustedHook: true },
    { threadMcp: true }
  ])('fails before turn/start on unproven policy/account/tools: %j', async (scenario) => {
    const { adapter, calls } = fixture(scenario)
    const receipt = await adapter.start(request)
    expect((await adapter.result(receipt.executionId)).status).toBe('FAILED')
    expect(calls.some((call) => call.method === 'turn/start')).toBe(false)
  })

  it('rejects dangerous and unknown request fields before resolving a process', async () => {
    const { adapter, prepare } = fixture()
    await expect(
      adapter.start({ ...request, permissionMode: 'FULL_ACCESS' } as never)
    ).rejects.toThrow()
    await expect(adapter.start({ ...request, env: { TOKEN: 'x' } } as never)).rejects.toThrow()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('treats missing final output as failure, not DONE', async () => {
    const { adapter } = fixture({ text: '' })
    expect((await adapter.result((await adapter.start(request)).executionId)).status).toBe('FAILED')
  })

  it('preserves uncertainty when transport fails after turn submission', async () => {
    const { adapter } = fixture({ disconnect: true })
    const result = await adapter.result((await adapter.start(request)).executionId)
    expect(result.status).toBe('OUTCOME_UNKNOWN')
    expect(result.error).not.toContain('secret-value')
  })

  it('cancels through turn/interrupt and waits for structured acknowledgement', async () => {
    const { adapter, calls } = fixture({ hold: true })
    const { executionId } = await adapter.start(request)
    await vi.waitFor(() => expect(adapter.getStatus(executionId).status).toBe('RUNNING'))
    expect(() => adapter.release(executionId)).toThrow(/active/)
    await adapter.cancel(executionId)
    expect((await adapter.result(executionId)).status).toBe('CANCELLED')
    expect(calls.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' }
    })
  })

  it('bounds progress metadata and redacts the result before returning it', async () => {
    const { adapter } = fixture({ progressCount: 400, text: 'Result password=not-for-ledger' })
    const { executionId } = await adapter.start(request)
    const result = await adapter.result(executionId)
    expect(result.text).not.toContain('not-for-ledger')
    const events = adapter.events(executionId)
    expect(events.truncated).toBe(true)
    expect(events.events).toHaveLength(256)
    expect(JSON.stringify(events)).not.toContain('sensitive-command')
  })

  it('ignores a final message for another thread or turn', async () => {
    const { adapter, emit } = fixture({ hold: true })
    const { executionId } = await adapter.start(request)
    await vi.waitFor(() => expect(adapter.getStatus(executionId).status).toBe('RUNNING'))
    emit('item/completed', {
      threadId: 'foreign',
      turnId: 'turn-1',
      item: { type: 'agentMessage', text: 'INJECTED' }
    })
    emit('item/completed', {
      threadId: 'thread-1',
      turnId: 'foreign',
      item: { type: 'agentMessage', text: 'INJECTED' }
    })
    emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    expect((await adapter.result(executionId)).text).toBe('READY')
  })
})
