import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log('[owned-process] Windows launcher build skipped')
} else {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const sourceFiles = ['orca-owned-process-tree.cs', 'orca-owned-process-io.cs']
  const sources = sourceFiles.map((file) => join(root, 'config', 'native', file))
  if (process.argv.includes('--check')) {
    const artifactRoot = join(root, 'out', 'owned-process')
    const manifest = JSON.parse(readFileSync(join(artifactRoot, 'launcher.json'), 'utf8'))
    const sourceHash = createHash('sha256')
    for (let i = 0; i < sources.length; i++) {
      sourceHash.update(`${sourceFiles[i]}\0`).update(readFileSync(sources[i]))
    }
    const binaryHash = createHash('sha256')
      .update(readFileSync(join(artifactRoot, 'orca-owned-process-tree.exe')))
      .digest('hex')
    if (
      manifest.schemaVersion !== 1 ||
      manifest.protocol !== 'orca-owned-process-v1' ||
      manifest.sourceSha256 !== sourceHash.digest('hex') ||
      manifest.binarySha256 !== binaryHash
    ) {
      throw new Error(
        'Owned process artifact is stale or modified; rebuild main and launcher together'
      )
    }
    console.log('[owned-process] artifact verification PASS')
    process.exit(0)
  }
  const compiler = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe'
  )
  if (!existsSync(compiler)) {
    throw new Error('Installed Windows .NET compiler is unavailable; launcher was not built')
  }
  const binary = join(root, 'out', 'owned-process', 'orca-owned-process-tree.exe')
  mkdirSync(dirname(binary), { recursive: true })
  const pending = `${binary}.${process.pid}.tmp.exe`
  execFileSync(
    compiler,
    [
      '/nologo',
      '/target:exe',
      '/platform:x64',
      '/reference:System.Web.Extensions.dll',
      `/out:${pending}`,
      ...sources
    ],
    {
      cwd: root,
      windowsHide: true,
      timeout: 30000,
      stdio: 'inherit'
    }
  )
  const sha256 = (data) => createHash('sha256').update(data).digest('hex')
  const sourceHash = createHash('sha256')
  for (let i = 0; i < sources.length; i++) {
    sourceHash.update(`${sourceFiles[i]}\0`).update(readFileSync(sources[i]))
  }
  const manifest = {
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    fileName: 'orca-owned-process-tree.exe',
    protocol: 'orca-owned-process-v1',
    binarySha256: sha256(readFileSync(pending)),
    sourceSha256: sourceHash.digest('hex')
  }
  renameSync(pending, binary)
  const manifestFile = join(dirname(binary), 'launcher.json')
  writeFileSync(`${manifestFile}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(`${manifestFile}.tmp`, manifestFile)
  console.log(JSON.stringify({ binary, manifestFile, ...manifest }))
}
