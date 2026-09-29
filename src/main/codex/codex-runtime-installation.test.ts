import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCodexRuntimeExecutable } from './codex-runtime-installation'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('host-side Codex executable discovery', () => {
  it('prefers an installed native executable over an npm shell shim', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-exe-'))
    dirs.push(root)
    const npm = join(root, 'npm')
    const bin = join(root, 'OpenAI', 'Codex', 'bin', 'current')
    mkdirSync(npm)
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(npm, 'codex.cmd'), 'shell shim')
    const executable = join(bin, 'codex.exe')
    writeFileSync(executable, 'native test fixture')
    expect(
      resolveCodexRuntimeExecutable({ platform: 'win32', pathEnv: npm, localAppData: root })
    ).toBe(executable)
  })

  it('fails closed when only a shell shim exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-exe-'))
    dirs.push(root)
    writeFileSync(join(root, 'codex.cmd'), 'shell shim')
    expect(() =>
      resolveCodexRuntimeExecutable({ platform: 'win32', pathEnv: root, localAppData: root })
    ).toThrow(/native Codex/)
  })
})
