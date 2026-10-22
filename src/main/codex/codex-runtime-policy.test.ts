import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { codexRuntimeEnvironment, prepareCodexRuntime } from './codex-runtime-policy'
import { runProcess } from '../../shared/child-process/run-process'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-policy-'))
  roots.push(root)
  const worktree = join(root, 'repo')
  const codexHome = join(root, 'profile')
  mkdirSync(worktree)
  mkdirSync(codexHome)
  const executablePath = join(root, 'codex.exe')
  writeFileSync(executablePath, 'test fixture, never executed')
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: 'codex-cli 0.158.0-alpha.2.1\n',
    stderr: ''
  })
  return {
    worktree,
    codexHome,
    executablePath,
    prompt: 'READY',
    permissionMode: 'READ_ONLY' as const,
    approvalPolicy: 'never' as const
  }
}

describe('Codex runtime resolved identity policy', () => {
  it('records the resolved installation and positively returned version', async () => {
    const input = fixture()
    expect(await prepareCodexRuntime(input)).toMatchObject({
      version: 'codex-cli 0.158.0-alpha.2.1',
      executable: input.executablePath
    })
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: input.executablePath,
        args: ['--version'],
        cwd: input.codexHome
      })
    )
  })

  it('rejects bare executable names before any process', async () => {
    await expect(prepareCodexRuntime({ ...fixture(), executablePath: 'codex' })).rejects.toThrow(
      /absolute/
    )
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('rejects workspace-local executable shadowing', async () => {
    const input = fixture()
    const executablePath = join(input.worktree, 'codex.exe')
    writeFileSync(executablePath, 'untrusted worktree fixture')
    await expect(prepareCodexRuntime({ ...input, executablePath })).rejects.toThrow(/outside/)
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('rejects a profile nested inside the worktree', async () => {
    const input = fixture()
    const codexHome = join(input.worktree, 'profile')
    mkdirSync(codexHome)
    await expect(prepareCodexRuntime({ ...input, codexHome })).rejects.toThrow(/separate/)
  })

  it('rejects global CODEX_HOME', async () => {
    await expect(
      prepareCodexRuntime({ ...fixture(), codexHome: join(homedir(), '.codex') })
    ).rejects.toThrow()
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('rejects a workspace containing global configuration even with a separate runtime profile', async () => {
    const input = fixture()
    await expect(
      prepareCodexRuntime({ ...input, worktree: join(homedir(), '.codex') })
    ).rejects.toThrow(/global configuration/)
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('rejects an invalid version response', async () => {
    const input = fixture()
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      timedOut: false,
      stdout: 'fake agent',
      stderr: ''
    })
    await expect(prepareCodexRuntime(input)).rejects.toThrow(/identify/)
  })

  it('does not forward unrelated parent environment or API credentials', () => {
    vi.stubEnv('OPENAI_API_KEY', 'not-a-real-key')
    vi.stubEnv('ORCA_RUNTIME_AUTH_TOKEN', 'not-a-real-token')
    vi.stubEnv('ARBITRARY_PRIVATE_VALUE', 'not-for-child')
    vi.stubEnv('CODEX_HOME', 'parent-profile')
    const env = codexRuntimeEnvironment('dedicated-profile')
    expect(env.CODEX_HOME).toBe('dedicated-profile')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ORCA_RUNTIME_AUTH_TOKEN).toBeUndefined()
    expect(env.ARBITRARY_PRIVATE_VALUE).toBeUndefined()
  })

  it('does not expose the owner profile through standard path variables', () => {
    const runtimeHome = 'C:\\orca-managed\\codex-home'
    vi.stubEnv('USERPROFILE', 'C:\\Users\\owner')
    vi.stubEnv('HOME', 'C:\\Users\\owner')
    vi.stubEnv('APPDATA', 'C:\\Users\\owner\\AppData\\Roaming')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\owner\\AppData\\Local')
    const env = codexRuntimeEnvironment(runtimeHome)
    expect(env.USERPROFILE).toBe(runtimeHome)
    expect(env.HOME).toBe(runtimeHome)
    expect(env.APPDATA).toBe('C:\\orca-managed\\codex-home\\AppData\\Roaming')
    expect(env.LOCALAPPDATA).toBe('C:\\orca-managed\\codex-home\\AppData\\Local')
    expect(env.HOMEDRIVE).toBe('C:')
    expect(env.HOMEPATH).toBe('\\orca-managed\\codex-home')
  })
})
