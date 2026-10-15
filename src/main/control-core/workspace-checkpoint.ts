import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  existsSync
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type {
  WorkspaceCheckpoint,
  WorkspaceFileFingerprint
} from '../../shared/control-evidence-contract'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'

const MAX_FILES = 50_000
const MAX_BYTES = 512 * 1024 * 1024
const OMIT_FOLDERS = new Set(['.git', 'node_modules'])
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

function folderFiles(root: string, at = root, found: string[] = []): string[] {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    if (entry.isDirectory() && OMIT_FOLDERS.has(entry.name)) {
      continue
    }
    const path = join(at, entry.name)
    if (entry.isDirectory()) {
      folderFiles(root, path, found)
    } else {
      found.push(relative(root, path).split('\\').join('/'))
    }
    if (found.length > MAX_FILES) {
      throw new Error('Workspace fingerprint exceeds file bound')
    }
  }
  return found
}

async function fingerprint(root: string, path: string): Promise<WorkspaceFileFingerprint> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error('Workspace path escapes its root')
  }
  const full = join(root, path)
  const stat = lstatSync(full)
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(full)
    return { path, kind: 'symlink', bytes: Buffer.byteLength(link), sha256: digest(link) }
  }
  if (!stat.isFile()) {
    throw new Error('Unsupported workspace entry; fingerprint incomplete')
  }
  const canonical = realpathSync(full)
  const rel = relative(root, canonical)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new Error('Workspace file escapes root')
  }
  if (stat.size > MAX_BYTES) {
    throw new Error('Workspace file exceeds fingerprint byte bound')
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(full)) {
    hash.update(chunk)
  }
  const after = lstatSync(full)
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) {
    throw new Error('Workspace changed during fingerprint capture')
  }
  return { path, kind: 'file', bytes: stat.size, sha256: hash.digest('hex') }
}

async function assertFingerprintsStable(
  root: string,
  files: WorkspaceFileFingerprint[]
): Promise<void> {
  for (const expected of files) {
    const actual = await fingerprint(root, expected.path)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('Workspace changed after fingerprint capture')
    }
  }
}

export async function captureWorkspaceCheckpoint(worktree: string): Promise<WorkspaceCheckpoint> {
  const root = realpathSync(worktree)
  const git = existsSync(join(root, '.git'))
  let baselineCommit: string | null = null
  let changedFiles: string[] = []
  let diffHash: string | null = null
  let paths: string[]
  let initialStatus = ''
  if (git) {
    const options = { cwd: root, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }
    const head = await gitExecFileAsync(['--no-optional-locks', 'rev-parse', 'HEAD'], options)
    baselineCommit = head.stdout.trim()
    initialStatus = (
      await gitExecFileAsync(
        ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
        options
      )
    ).stdout
    paths = [
      ...new Set(
        (
          await gitExecFileAsync(
            ['--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
            options
          )
        ).stdout
          .split('\0')
          .filter(Boolean)
      )
    ]
    changedFiles = [
      ...new Set(
        (
          await gitExecFileAsync(
            ['--no-optional-locks', 'diff', '--name-only', '-z', 'HEAD'],
            options
          )
        ).stdout
          .split('\0')
          .filter(Boolean)
          .concat(
            (
              await gitExecFileAsync(
                ['--no-optional-locks', 'ls-files', '-z', '--others', '--exclude-standard'],
                options
              )
            ).stdout
              .split('\0')
              .filter(Boolean)
          )
      )
    ]
    diffHash = digest(
      (await gitExecFileAsync(['--no-optional-locks', 'diff', '--binary', 'HEAD'], options)).stdout
    )
  } else {
    paths = folderFiles(root)
  }
  if (paths.length > MAX_FILES) {
    throw new Error('Workspace fingerprint exceeds file bound')
  }
  const files: WorkspaceFileFingerprint[] = []
  let bytes = 0
  for (const path of paths.sort()) {
    try {
      lstatSync(join(root, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
    const file = await fingerprint(root, path)
    bytes += file.bytes
    if (bytes > MAX_BYTES) {
      throw new Error('Workspace fingerprint exceeds total byte bound')
    }
    files.push(file)
  }
  await assertFingerprintsStable(root, files)
  if (!git && JSON.stringify(folderFiles(root).sort()) !== JSON.stringify(paths)) {
    throw new Error('Workspace file inventory changed during capture')
  }
  if (git) {
    const options = { cwd: root, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }
    const finalStatus = (
      await gitExecFileAsync(
        ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
        options
      )
    ).stdout
    const finalHead = (
      await gitExecFileAsync(['--no-optional-locks', 'rev-parse', 'HEAD'], options)
    ).stdout.trim()
    if (finalStatus !== initialStatus || finalHead !== baselineCommit) {
      throw new Error('Git workspace changed during capture')
    }
  }
  return {
    checkpointId: randomUUID(),
    worktree: root,
    kind: git ? 'git' : 'folder',
    baselineCommit,
    workspaceHash: digest(
      JSON.stringify({ baselineCommit, gitStatusHash: digest(initialStatus), files })
    ),
    changedFiles: changedFiles.sort(),
    diffHash,
    files,
    capturedAt: new Date().toISOString()
  }
}
