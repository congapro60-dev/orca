import { afterEach, describe, expect, it } from 'vitest'
import { runCodexAppServerSession } from './codex-app-server-session'
import type { CodexProcessObservation } from './codex-process-observation'
import { spawnThroughProcessBoundary } from './codex-app-server-process'
import type {
  ChildProcessHandle,
  ProcessSpawnImplementation
} from '../../shared/child-process/run-process'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
})

describe('runCodexAppServerSession environment', () => {
  it('reaps a live child after a post-spawn error instead of treating error as exit', async () => {
    let child: ChildProcessHandle
    const observations: CodexProcessObservation[] = []
    await expect(
      runCodexAppServerSession(
        {
          command: process.execPath,
          cliPath: null,
          args: [
            '-e',
            String.raw`
        require('node:readline').createInterface({input:process.stdin}).on('line', line => {
          const m = JSON.parse(line); if (m.id) process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\n')
        });
        const held = setInterval(()=>{},1000);
        process.stdin.on('end',()=>setTimeout(()=>clearInterval(held),50));
      `
          ],
          timeoutMs: 10000,
          onProcessObservation: (value) => observations.push(value)
        },
        async () => {
          child.emit('error', new Error('post-spawn failure'))
          return new Promise<never>(() => {})
        },
        ((command, args, options) => {
          child = spawnThroughProcessBoundary(command, args, options)
          return child
        }) as ProcessSpawnImplementation
      )
    ).rejects.toThrow('post-spawn failure')
    expect(observations.at(-1)).toMatchObject({
      verdict: 'exited',
      exitCode: 0,
      treeVerdict: 'unverifiable'
    })
  })

  it('rejects an unbounded graceful shutdown allowance before spawning', async () => {
    await expect(
      runCodexAppServerSession(
        {
          command: 'never-start',
          cliPath: null,
          args: [],
          timeoutMs: 1000,
          gracefulShutdownMs: Infinity
        },
        async () => null
      )
    ).rejects.toThrow(/shutdown bound/)
  })

  it('surfaces a process observer failure during final reap instead of reporting success', async () => {
    await expect(
      runCodexAppServerSession(
        {
          command: process.execPath,
          cliPath: null,
          args: [
            '-e',
            `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const m = JSON.parse(line); if (m.id) process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n')
      })`
          ],
          timeoutMs: 5000,
          onProcessObservation: (value) => {
            if (value.verdict === 'exited') {
              throw new Error('exit persistence failed')
            }
          }
        },
        async () => 'success'
      )
    ).rejects.toThrow('exit persistence failed')
  })
  it('removes inherited variables requested by a default-home invocation', async () => {
    process.env.CODEX_HOME = '/tmp/inherited-managed-home'
    const server = String.raw`
      const readline = require('node:readline')
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (typeof message.id !== 'number') return
        const result = message.method === 'env/get'
          ? { codexHome: process.env.CODEX_HOME ?? null }
          : {}
        process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
      })
    `

    const observations: CodexProcessObservation[] = []
    const result = await runCodexAppServerSession(
      {
        command: process.execPath,
        cliPath: null,
        args: ['-e', server],
        envToDelete: ['CODEX_HOME'],
        onProcessObservation: (value) => observations.push(value),
        verifyProcessTree: async () => 'unverifiable',
        timeoutMs: 5_000
      },
      ({ request }) => request('env/get')
    )

    expect(result).toEqual({ codexHome: null })
    expect(observations.some((value) => value.verdict === 'live')).toBe(true)
    expect(observations.at(-1)).toMatchObject({
      verdict: 'exited',
      exitCode: 0,
      scope: 'app-server-child'
    })
    expect(observations.at(-1)?.treeVerdict).toBe('unverifiable')
  })

  it('publishes tree verdict separately from parent exit', async () => {
    const observations: CodexProcessObservation[] = []
    await runCodexAppServerSession(
      {
        command: process.execPath,
        cliPath: null,
        args: [
          '-e',
          "process.stdin.on('data',d=>{const m=JSON.parse(d);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n')})"
        ],
        timeoutMs: 5000,
        onProcessObservation: (value) => observations.push(value),
        verifyProcessTree: async () => 'exited'
      },
      async () => 'done'
    )
    expect(observations.at(-1)).toMatchObject({ verdict: 'exited', treeVerdict: 'exited' })
  })
})
