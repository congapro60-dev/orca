import type {
  ProcessSpawnImplementation,
  PipedProcessHandle
} from '../../shared/child-process/run-process'
import {
  killCodexAppServerProcessTree,
  reapCodexAppServerProcess,
  spawnThroughProcessBoundary
} from './codex-app-server-process'
export { killCodexAppServerProcessTree } from './codex-app-server-process'
import {
  stderrIndicatesMissingAppServer,
  isCodexRpcMethodNotFound,
  codexEarlyExitError
} from './codex-app-server-capability-signal'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import {
  observeCodexProcess,
  codexProcessObserverGuard,
  publishTreeVerdict,
  type CodexProcessObservation
} from './codex-process-observation'

export type CodexAppServerInvocation = {
  command: string
  args: string[]
  cliPath: string | null
  env?: Record<string, string>
  inheritEnv?: boolean
  envToDelete?: readonly string[]
  timeoutMs: number
  cwd?: string
  signal?: AbortSignal
  onNotification?: (method: string, params: unknown) => void
  onProcessObservation?: (observation: CodexProcessObservation) => void
  verifyProcessTree?: (pid: number | null) => Promise<'exited' | 'unverifiable'>
  gracefulShutdownMs?: number
}

export class CodexAppServerUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAppServerUnsupportedError'
  }
}

export class CodexAppServerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAppServerTimeoutError'
  }
}

export function isCodexAppServerUnsupportedError(error: unknown): boolean {
  return error instanceof Error && error.name === 'CodexAppServerUnsupportedError'
}

type JsonRpcResponse = {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

export type CodexAppServerRpc = {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  notify: (method: string, params?: Record<string, unknown>) => void
}

const STDERR_TAIL_MAX_BYTES = 8192
const STDOUT_LINE_MAX_BYTES = 1024 * 1024

export async function runCodexAppServerSession<T>(
  invocation: CodexAppServerInvocation,
  body: (rpc: CodexAppServerRpc) => Promise<T>,
  spawnImpl: ProcessSpawnImplementation = spawnThroughProcessBoundary
): Promise<T> {
  const graceMs = invocation.gracefulShutdownMs ?? 1500
  if (!Number.isInteger(graceMs) || graceMs < 1 || graceMs > 10000) {
    throw new Error('Invalid app-server graceful shutdown bound')
  }
  if (!invocation.onProcessObservation) {
    return runObservedSession(invocation, body, spawnImpl)
  }
  const guard = codexProcessObserverGuard(invocation.onProcessObservation)
  const result = await runObservedSession(
    {
      ...invocation,
      onProcessObservation: guard.publish
    },
    body,
    spawnImpl
  )
  guard.assert()
  return result
}

async function runObservedSession<T>(
  invocation: CodexAppServerInvocation,
  body: (rpc: CodexAppServerRpc) => Promise<T>,
  spawnImpl: ProcessSpawnImplementation = spawnThroughProcessBoundary
): Promise<T> {
  invocation.signal?.throwIfAborted()
  const childEnv: NodeJS.ProcessEnv = {
    ...(invocation.inheritEnv === false ? {} : process.env),
    ...invocation.env
  }
  for (const key of invocation.envToDelete ?? []) {
    delete childEnv[key]
  }
  const pairedEnv = invocation.cliPath
    ? withCliRuntimeOnPath(invocation.cliPath, childEnv)
    : childEnv
  const child = spawnImpl(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: pairedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  }) as PipedProcessHandle

  let stderrTail = ''
  let exited = false
  let lastObservation: CodexProcessObservation | null = null
  let nextRequestId = 1
  let timedOut = false
  let sessionError: Error | null = null
  const pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >()
  let rejectSession: (error: Error) => void = () => {}
  const sessionFailure = new Promise<never>((_resolve, reject) => {
    rejectSession = reject
  })
  void sessionFailure.catch(() => {})
  const exitPromise = new Promise<void>((resolve) => {
    child.on('exit', () => {
      exited = true
      resolve()
    })
  })
  child.on('error', (error) => {
    failPending(error)
  })
  child.on('close', () => {
    failPending(codexEarlyExitError(stderrTail))
  })
  const acceptStderr = (chunk: string): void => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_BYTES)
  }
  child.stdin.on('error', (error) => {
    failPending(error)
  })

  let stdoutBuffer = ''
  const acceptStdout = (chunk: string): void => {
    stdoutBuffer += chunk
    if (Buffer.byteLength(stdoutBuffer) > STDOUT_LINE_MAX_BYTES) {
      child.stdout.destroy()
      killCodexAppServerProcessTree(child)
      failPending(new Error('codex app-server emitted an oversized JSONL response'))
      return
    }
    let newlineIndex
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim()
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      if (!line) {
        continue
      }
      let message: JsonRpcResponse
      try {
        message = JSON.parse(line) as JsonRpcResponse
      } catch {
        continue
      }
      if (message.method) {
        if (message.id !== undefined) {
          failPending(
            new Error(`codex app-server requires unsupported interaction: ${message.method}`)
          )
        } else {
          try {
            invocation.onNotification?.(message.method, message.params)
          } catch (error) {
            failPending(error instanceof Error ? error : new Error(String(error)))
          }
        }
        continue
      }
      if (typeof message.id === 'number' && pending.has(message.id)) {
        const waiter = pending.get(message.id)!
        pending.delete(message.id)
        waiter.resolve(message)
      }
    }
  }
  child.stdout.setEncoding('utf8').on('data', acceptStdout)
  child.stderr.setEncoding('utf8').on('data', acceptStderr)

  function failPending(error: Error): void {
    sessionError ??= error
    rejectSession(error)
    for (const waiter of pending.values()) {
      waiter.reject(error)
    }
    pending.clear()
  }
  const deadline = setTimeout(() => {
    timedOut = true
    const error = new CodexAppServerTimeoutError(
      `codex app-server session exceeded ${invocation.timeoutMs}ms (${invocation.command})`
    )
    if (invocation.gracefulShutdownMs === undefined) {
      killCodexAppServerProcessTree(child)
    }
    failPending(error)
  }, invocation.timeoutMs)
  const abort = (): void => {
    failPending(new Error('codex app-server session aborted'))
    if (invocation.gracefulShutdownMs === undefined) {
      killCodexAppServerProcessTree(child)
    }
  }
  invocation.signal?.addEventListener('abort', abort, { once: true })
  if (invocation.signal?.aborted) {
    abort()
  }
  function sendLine(payload: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }
  function notify(method: string, params?: Record<string, unknown>): void {
    try {
      sendLine({ method, ...(params !== undefined ? { params } : {}) })
    } catch {}
  }

  async function requestRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    invocation.signal?.throwIfAborted()
    if (sessionError) {
      throw sessionError
    }
    if (timedOut) {
      throw new CodexAppServerTimeoutError('codex app-server session already timed out')
    }
    if (exited) {
      throw codexEarlyExitError(stderrTail)
    }
    const id = nextRequestId++
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      const payload: Record<string, unknown> = { method, id }
      if (params !== undefined) {
        payload.params = params
      }
      try {
        sendLine(payload)
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    if (response.error) {
      if (isCodexRpcMethodNotFound(response.error)) {
        throw new CodexAppServerUnsupportedError(
          `codex app-server does not support ${method}: ${response.error.message ?? 'method not found'}`
        )
      }
      throw new Error(
        `codex app-server ${method} failed: ${response.error.message ?? 'unknown error'}`
      )
    }
    return response.result
  }

  try {
    const observe = (value: CodexProcessObservation) => (
      (lastObservation = value),
      invocation.onProcessObservation?.(value)
    )
    observeCodexProcess(child, observe, failPending)()
    const session = async (): Promise<T> => {
      await requestRpc('initialize', {
        clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' }
      })
      notify('initialized')
      return body({ request: requestRpc, notify })
    }
    return await Promise.race([session(), sessionFailure])
  } catch (error) {
    if (
      error instanceof Error &&
      !(error instanceof CodexAppServerUnsupportedError) &&
      !(error instanceof CodexAppServerTimeoutError) &&
      stderrIndicatesMissingAppServer(stderrTail)
    ) {
      throw new CodexAppServerUnsupportedError(
        `codex CLI does not support the app-server subcommand: ${stderrTail.trim().slice(0, 400)}`
      )
    }
    throw error
  } finally {
    invocation.signal?.removeEventListener('abort', abort)
    clearTimeout(deadline)
    await reapCodexAppServerProcess(child, exitPromise, () => exited, invocation.gracefulShutdownMs)
    await publishTreeVerdict(
      lastObservation as CodexProcessObservation | null,
      invocation.verifyProcessTree,
      invocation.onProcessObservation
    )
  }
}
