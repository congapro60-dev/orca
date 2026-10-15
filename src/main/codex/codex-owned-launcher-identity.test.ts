import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
import {
  verifyOwnedProcessLauncher,
  resolveOwnedProcessLauncherArtifact
} from './codex-owned-launcher-identity'

const directories: string[] = []
afterEach(() =>
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
)
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-launcher-identity-'))
  directories.push(dir)
  const binary = join(dir, 'orca-owned-process-tree.exe')
  const manifestFile = join(dir, 'launcher.json')
  const bytes = 'fixture binary, not executable'
  const manifest = {
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    fileName: 'orca-owned-process-tree.exe',
    protocol: 'orca-owned-process-v1',
    binarySha256: createHash('sha256').update(bytes).digest('hex'),
    sourceSha256: 'a'.repeat(64)
  }
  return { dir, binary, manifestFile, bytes, manifest }
}
describe('Host-built owned launcher identity', () => {
  it('does not accept a caller path and resolves only host-owned locations', () => {
    const identity = resolveOwnedProcessLauncherArtifact()
    if (identity) {
      expect(identity.executablePath.toLowerCase()).toContain('out')
    } else {
      expect(identity).toBeNull()
    }
  })
  it('does not invent identity for absent or partial artifacts', () => {
    const f = fixture()
    expect(verifyOwnedProcessLauncher(f.dir)).toBeNull()
    writeFileSync(f.binary, f.bytes)
    expect(() => verifyOwnedProcessLauncher(f.dir)).toThrow(/incomplete/)
  })
  it('validates hash, rejects tampering, and refuses manifest path/protocol substitution', () => {
    const f = fixture()
    writeFileSync(f.binary, f.bytes)
    writeFileSync(f.manifestFile, JSON.stringify(f.manifest))
    expect(verifyOwnedProcessLauncher(f.dir)?.binarySha256).toBe(f.manifest.binarySha256)
    expect(verifyOwnedProcessLauncher(f.dir, f.manifest.binarySha256)?.binarySha256).toBe(
      f.manifest.binarySha256
    )
    expect(() => verifyOwnedProcessLauncher(f.dir, '0'.repeat(64))).toThrow(/integrity mismatch/)
    writeFileSync(f.binary, 'modified')
    expect(() => verifyOwnedProcessLauncher(f.dir)).toThrow(/integrity mismatch/)
    writeFileSync(
      f.manifestFile,
      JSON.stringify({
        ...f.manifest,
        binarySha256: createHash('sha256').update('modified').digest('hex')
      })
    )
    expect(() => verifyOwnedProcessLauncher(f.dir, f.manifest.binarySha256)).toThrow(
      /integrity mismatch/
    )
    writeFileSync(f.binary, f.bytes)
    writeFileSync(f.manifestFile, JSON.stringify({ ...f.manifest, fileName: '../foreign.exe' }))
    expect(() => verifyOwnedProcessLauncher(f.dir)).toThrow()
    writeFileSync(f.manifestFile, JSON.stringify({ ...f.manifest, protocol: 'foreign-protocol' }))
    expect(() => verifyOwnedProcessLauncher(f.dir)).toThrow()
  })
})
