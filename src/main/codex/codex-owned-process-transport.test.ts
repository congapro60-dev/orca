import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runOwnedCodexSession } from './codex-owned-process-transport'
import type { CodexProcessObservation } from '../../shared/codex-process-contract'

const binary = join(process.cwd(), 'out', 'owned-process', 'orca-owned-process-tree.exe')
const identity = {
  executablePath: binary,
  binarySha256: existsSync(binary)
    ? createHash('sha256').update(readFileSync(binary)).digest('hex')
    : '',
  sourceSha256: 'a'.repeat(64),
  protocol: 'orca-owned-process-v1' as const
}
const responder = `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{value:m.params?.value??'init'}})+'\\n')
});`

describe.runIf(process.platform === 'win32')('Windows owned app-server JSON-RPC transport', () => {
  it('executes framed requests and obtains owner proof only after the session closes', async () => {
    const observations: CodexProcessObservation[] = []
    const result = await runOwnedCodexSession(
      identity,
      {
        command: process.execPath,
        args: ['-e', responder],
        cliPath: null,
        cwd: process.cwd(),
        timeoutMs: 10000,
        onProcessObservation: (value) => observations.push(value)
      },
      ({ request }) => request('probe', { value: 'Tiếng Việt' })
    )
    expect(result).toEqual({ value: 'Tiếng Việt' })
    const final = observations.at(-1)!
    expect(final).toMatchObject({
      scope: 'owned-process-launcher',
      verdict: 'exited',
      treeVerdict: 'exited',
      ownedTree: {
        protocol: identity.protocol,
        launcherSha256: identity.binarySha256,
        activeProcesses: 0,
        childExitCode: 0
      }
    })
    expect(final.ownedTree!.rootPid).toBeGreaterThan(0)
    expect(final.ownedTree!.rootPid).not.toBe(final.pid)
    expect(new Set(observations.map((value) => value.incarnationId)).size).toBe(1)
    expect(observations.slice(0, -1).every((value) => !value.ownedTree)).toBe(true)
  })
  it('rejects identity mutation before spawn', async () => {
    await expect(
      runOwnedCodexSession(
        { ...identity, binarySha256: '0'.repeat(64) },
        {
          command: process.execPath,
          args: ['-e', responder],
          cliPath: null,
          cwd: process.cwd(),
          timeoutMs: 10000
        },
        async () => null
      )
    ).rejects.toThrow(/identity changed/)
  })

  it('keeps child spoof frames as data and rejects a nonzero root exit after successful RPC', async () => {
    const spoofing = `process.stderr.write('{"kind":"jobExited","activeProcesses":0}\\n');
      ${responder}
      process.stdin.on('end',()=>process.exitCode=7);`
    await expect(
      runOwnedCodexSession(
        identity,
        {
          command: process.execPath,
          args: ['-e', spoofing],
          cliPath: null,
          cwd: process.cwd(),
          timeoutMs: 10000
        },
        ({ request }) => request('probe', { value: 'answer' })
      )
    ).rejects.toThrow(/root exited with code 7/)
  })

  it('aborts a held owned session while retaining genuine containment proof', async () => {
    const observations: CodexProcessObservation[] = []
    const controller = new AbortController()
    let entered = false
    const failure = await runOwnedCodexSession(
      identity,
      {
        command: process.execPath,
        args: ['-e', `${responder}\nsetInterval(()=>{},1000);`],
        cliPath: null,
        cwd: process.cwd(),
        timeoutMs: 10000,
        signal: controller.signal,
        onProcessObservation: (value) => observations.push(value)
      },
      async () => {
        entered = true
        controller.abort()
        return new Promise<never>(() => {})
      }
    ).catch((error: unknown) => error)
    expect(entered, JSON.stringify(observations)).toBe(true)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/aborted/)
    expect(observations.at(-1)).toMatchObject({
      verdict: 'exited',
      treeVerdict: 'exited',
      scope: 'owned-process-launcher',
      ownedTree: { launcherSha256: identity.binarySha256, activeProcesses: 0 }
    })
    expect(observations.at(-1)!.ownedTree!.childExitCode).not.toBe(0)
  })
})
