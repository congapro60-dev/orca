import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import type { PathLike, ReadStream } from 'node:fs'
import type * as Fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { captureWorkspaceCheckpoint } from './workspace-checkpoint'

const readHook = vi.hoisted(() => ({ beforeRead: null as ((path: string) => void) | null }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = (await importOriginal()) as typeof Fs
  return {
    ...fs,
    createReadStream: (path: PathLike): ReadStream => {
      readHook.beforeRead?.(String(path))
      return fs.createReadStream(path)
    }
  }
})

const directories: string[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-checkpoint-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  readHook.beforeRead = null
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Host workspace fingerprints', () => {
  it('keeps a stable folder checkpoint and detects changed or newly added content', async () => {
    const directory = fixture()
    writeFileSync(join(directory, 'source.ts'), 'export const value = 1\n')
    mkdirSync(join(directory, 'node_modules'))
    writeFileSync(join(directory, 'node_modules', 'ignored.js'), 'dependency')
    const first = await captureWorkspaceCheckpoint(directory)
    const same = await captureWorkspaceCheckpoint(directory)
    expect(first.kind).toBe('folder')
    expect(first.baselineCommit).toBeNull()
    expect(first.files.map((file) => file.path)).toEqual(['source.ts'])
    expect(same.workspaceHash).toBe(first.workspaceHash)
    writeFileSync(join(directory, 'source.ts'), 'export const value = 2\n')
    expect((await captureWorkspaceCheckpoint(directory)).workspaceHash).not.toBe(
      first.workspaceHash
    )
    writeFileSync(join(directory, 'new.txt'), 'new')
    expect((await captureWorkspaceCheckpoint(directory)).files).toHaveLength(2)
    expect(JSON.stringify(first)).not.toContain('export const value')
  })

  it('captures Git baseline, tracked/untracked edits and changes in index state', async () => {
    const directory = fixture()
    const git = (args: string[]) => gitExecFileAsync(args, { cwd: directory, timeout: 10_000 })
    await git(['init'])
    await git(['config', 'user.name', 'ORCA checkpoint test'])
    await git(['config', 'user.email', 'checkpoint@example.test'])
    writeFileSync(join(directory, 'source.ts'), 'one')
    await git(['add', 'source.ts'])
    await git(['commit', '-m', 'fixture baseline'])
    const clean = await captureWorkspaceCheckpoint(directory)
    expect(clean.baselineCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(clean.changedFiles).toEqual([])
    writeFileSync(join(directory, 'source.ts'), 'two')
    writeFileSync(join(directory, 'new.txt'), 'untracked')
    const dirty = await captureWorkspaceCheckpoint(directory)
    expect(dirty.changedFiles).toEqual(['new.txt', 'source.ts'])
    expect(dirty.workspaceHash).not.toBe(clean.workspaceHash)
    expect(dirty.diffHash).not.toBe(clean.diffHash)
    await git(['add', 'source.ts'])
    const staged = await captureWorkspaceCheckpoint(directory)
    expect(staged.files).toEqual(dirty.files)
    expect(staged.workspaceHash).not.toBe(dirty.workspaceHash)
    expect(staged.baselineCommit).toBe(clean.baselineCommit)
  })

  it('fails closed when a file changes during the final stability pass', async () => {
    const directory = fixture()
    writeFileSync(join(directory, 'a.ts'), 'stable')
    writeFileSync(join(directory, 'b.ts'), 'unchanged')
    readHook.beforeRead = (path) => {
      if (path.endsWith('b.ts')) {
        readHook.beforeRead = null
        writeFileSync(join(directory, 'a.ts'), 'changed after a.ts was hashed')
      }
    }
    await expect(captureWorkspaceCheckpoint(directory)).rejects.toThrow(
      /changed after fingerprint capture/
    )
  })

  it('rejects a new file appearing after folder inventory was captured', async () => {
    const directory = fixture()
    writeFileSync(join(directory, 'a.ts'), 'stable')
    readHook.beforeRead = () => {
      readHook.beforeRead = null
      writeFileSync(join(directory, 'new.ts'), 'appeared during capture')
    }
    await expect(captureWorkspaceCheckpoint(directory)).rejects.toThrow(/inventory changed/)
  })
})
