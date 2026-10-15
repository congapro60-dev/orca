import { randomUUID } from 'node:crypto'
import type { ChildProcessHandle } from '../../shared/child-process/run-process'
import type { CodexProcessObservation } from '../../shared/codex-process-contract'
import { verifyCodexProcessTreeExited } from './codex-process-tree-verifier'
export type { CodexProcessObservation } from '../../shared/codex-process-contract'

export async function withTreeVerdict(
  observation: CodexProcessObservation,
  verify: ((pid: number | null) => Promise<'exited' | 'unverifiable'>) | undefined,
  publish: (value: CodexProcessObservation) => void
): Promise<void> {
  publish({
    ...observation,
    treeVerdict: await (verify ?? verifyCodexProcessTreeExited)(observation.pid)
  })
}

export async function publishTreeVerdict(
  observation: CodexProcessObservation | null,
  verify: ((pid: number | null) => Promise<'exited' | 'unverifiable'>) | undefined,
  publish: ((value: CodexProcessObservation) => void) | undefined
): Promise<void> {
  if (observation?.verdict === 'exited' && publish) {
    await withTreeVerdict(observation, verify, publish)
  }
}

export function codexProcessObserverGuard(
  publish: ((value: CodexProcessObservation) => void) | undefined
) {
  let failure: Error | null = null
  return {
    publish(value: CodexProcessObservation) {
      try {
        publish?.(value)
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        throw failure
      }
    },
    assert() {
      if (failure) {
        throw failure
      }
    }
  }
}

/** Exit is tied to this host-owned child handle, never inferred from RPC failure or PID lookup. */
export function observeCodexProcess(
  child: ChildProcessHandle,
  publish: ((observation: CodexProcessObservation) => void) | undefined,
  failed: (error: Error) => void
): () => void {
  const identity = {
    incarnationId: randomUUID(),
    pid: child.pid ?? null,
    scope: 'app-server-child' as const
  }
  let observation: CodexProcessObservation = {
    ...identity,
    verdict: 'unverifiable',
    observedAt: new Date().toISOString(),
    exitCode: null,
    signal: null
  }
  const report = () => {
    try {
      publish?.(structuredClone(observation))
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)))
    }
  }
  child.once('spawn', () => {
    observation = {
      ...observation,
      pid: child.pid ?? null,
      verdict: child.pid ? 'live' : 'unverifiable',
      observedAt: new Date().toISOString()
    }
    report()
  })
  child.once('exit', (exitCode, signal) => {
    observation = {
      ...observation,
      verdict: 'exited',
      observedAt: new Date().toISOString(),
      exitCode,
      signal
    }
    report()
  })
  child.once('error', () => {
    if (observation.verdict !== 'exited') {
      observation = {
        ...observation,
        verdict: 'unverifiable',
        observedAt: new Date().toISOString()
      }
      report()
    }
  })
  return report
}
