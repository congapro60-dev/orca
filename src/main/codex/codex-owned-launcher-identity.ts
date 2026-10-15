import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { app } from 'electron'

const Manifest = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.literal('win32'),
    arch: z.literal('x64'),
    fileName: z.literal('orca-owned-process-tree.exe'),
    protocol: z.literal('orca-owned-process-v1'),
    binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()

/** Artifact root is host/build-owned, never an RPC/UI-supplied path. Hash is integrity, not a signature. */
export function verifyOwnedProcessLauncher(artifactDirectory: string, expectedSha256?: string) {
  const binary = join(artifactDirectory, 'orca-owned-process-tree.exe')
  const manifestFile = join(artifactDirectory, 'launcher.json')
  if (!existsSync(binary) && !existsSync(manifestFile)) {
    return null
  }
  if (!existsSync(binary) || !existsSync(manifestFile)) {
    throw new Error('Owned process launcher artifact is incomplete')
  }
  const root = realpathSync(artifactDirectory)
  for (const file of [binary, manifestFile]) {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 1024 * 1024 || dirname(realpathSync(file)) !== root) {
      throw new Error('Owned process launcher artifact escaped its root or exceeded bound')
    }
  }
  const manifest = Manifest.parse(JSON.parse(readFileSync(manifestFile, 'utf8')))
  const actual = createHash('sha256').update(readFileSync(binary)).digest('hex')
  if (actual !== manifest.binarySha256 || (expectedSha256 && actual !== expectedSha256)) {
    throw new Error('Owned process launcher binary integrity mismatch')
  }
  return {
    executablePath: realpathSync(binary),
    binarySha256: actual,
    sourceSha256: manifest.sourceSha256,
    protocol: manifest.protocol
  }
}

/** Resolve only the app-owned packaged/dev location; never accept an RPC path. */
export function resolveOwnedProcessLauncherArtifact(): ReturnType<
  typeof verifyOwnedProcessLauncher
> {
  const pin = typeof ORCA_OWNED_LAUNCHER_SHA256 === 'undefined' ? null : ORCA_OWNED_LAUNCHER_SHA256
  if (!pin) {
    return null
  }
  return verifyOwnedProcessLauncher(
    app.isPackaged
      ? join(process.resourcesPath, 'bin', 'owned-process')
      : join(app.getAppPath(), 'out', 'owned-process'),
    pin
  )
}
