import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  PipedProcessHandle,
  ProcessSpawnImplementation
} from '../../shared/child-process/run-process'
import { spawnThroughProcessBoundary } from './codex-app-server-process'
import { OwnedProcessFrameParser, type OwnedProcessProof } from './codex-owned-process-frame'
import {
  runCodexAppServerSession,
  type CodexAppServerInvocation,
  type CodexAppServerRpc
} from './codex-app-server-session'
import type { verifyOwnedProcessLauncher } from './codex-owned-launcher-identity'

/** Same JSON-RPC surface over a verified launcher; no worker output can publish the proof. */
export async function runOwnedCodexSession<T>(
  identity: NonNullable<ReturnType<typeof verifyOwnedProcessLauncher>>,
  invocation: CodexAppServerInvocation,
  body: (rpc: CodexAppServerRpc) => Promise<T>
): Promise<T> {
  identity = { ...identity }
  const hash = createHash('sha256').update(readFileSync(identity.executablePath)).digest('hex')
  if (hash !== identity.binarySha256 || identity.protocol !== 'orca-owned-process-v1') {
    throw new Error('Owned launcher identity changed before spawn')
  }
  let proof: OwnedProcessProof | null = null
  let failure: Error | null = null
  let spawned = false
  let settleClose!: (error?: Error) => void
  const launcherClose = new Promise<void>((resolve, reject) => {
    settleClose = (error) => (error ? reject(error) : resolve())
  })
  void launcherClose.catch(() => {})
  const spawn: ProcessSpawnImplementation = ((program, args, options) => {
    if (spawned) {
      throw new Error('An owned session cannot spawn a second launcher')
    }
    spawned = true
    const real = spawnThroughProcessBoundary(
      identity.executablePath,
      [
        '--framed',
        `--timeout-ms=${invocation.timeoutMs}`,
        program,
        invocation.cwd ?? process.cwd(),
        ...args
      ],
      options
    ) as PipedProcessHandle
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const virtual = Object.assign(new EventEmitter(), {
      pid: real.pid,
      stdin: real.stdin,
      stdout,
      stderr,
      kill: real.kill.bind(real),
      unref: real.unref.bind(real)
    })
    const parser = new OwnedProcessFrameParser(undefined, (kind, text) => {
      if (kind === 'stdout') {
        stdout.write(text)
      } else {
        stderr.write(text)
      }
    })
    const fail = (error: unknown) => {
      if (failure) {
        return
      }
      failure = error instanceof Error ? error : new Error(String(error))
      proof = null
      virtual.emit('error', failure)
      real.kill('SIGKILL')
    }
    real.on('spawn', () => virtual.emit('spawn'))
    real.on('error', fail)
    real.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      try {
        parser.feed(chunk)
      } catch (error) {
        fail(error)
      }
    })
    real.stderr.on('data', (chunk) => stderr.write(chunk))
    real.on('close', (code, signal) => {
      if (!failure) {
        try {
          if (code !== 0 || signal) {
            throw new Error('Owned launcher did not close successfully')
          }
          proof = parser.finish()
        } catch (error) {
          fail(error)
        }
      }
      stdout.end()
      stderr.end()
      virtual.emit('exit', code, signal)
      virtual.emit('close', code, signal)
      settleClose(failure ?? undefined)
    })
    return virtual as unknown as PipedProcessHandle
  }) as ProcessSpawnImplementation
  const result = await runCodexAppServerSession(
    {
      ...invocation,
      gracefulShutdownMs: 7500,
      onProcessObservation: invocation.onProcessObservation
        ? (observation) => {
            const ownedTree =
              proof && !failure && observation.treeVerdict === 'exited'
                ? {
                    protocol: identity.protocol,
                    launcherSha256: identity.binarySha256,
                    rootPid: proof.rootPid,
                    activeProcesses: proof.activeProcesses,
                    totalProcesses: proof.totalProcesses,
                    childExitCode: proof.childExitCode
                  }
                : undefined
            invocation.onProcessObservation!({
              ...observation,
              scope: 'owned-process-launcher',
              ...(ownedTree ? { ownedTree } : {})
            })
          }
        : undefined,
      verifyProcessTree: async () => (proof && !failure ? 'exited' : 'unverifiable')
    },
    body,
    spawn
  )
  await launcherClose
  if (failure) {
    throw failure
  }
  if (!proof) {
    throw new Error('Owned session did not obtain final containment proof')
  }
  if ((proof as OwnedProcessProof).childExitCode !== 0) {
    throw new Error(
      `Owned app-server root exited with code ${(proof as OwnedProcessProof).childExitCode}`
    )
  }
  return result
}
