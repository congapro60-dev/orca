import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcessHandle } from '../../shared/child-process/run-process'
import { observeCodexProcess, type CodexProcessObservation } from './codex-process-observation'

describe('Host-owned child process observations', () => {
  it('never converts close or error into exit proof', () => {
    const child = Object.assign(new EventEmitter(), { pid: 123 }) as ChildProcessHandle
    const observations: CodexProcessObservation[] = []
    const fail = vi.fn()
    observeCodexProcess(child, (value) => observations.push(value), fail)()
    expect(observations.at(-1)?.verdict).toBe('unverifiable')
    child.emit('spawn')
    expect(observations.at(-1)?.verdict).toBe('live')
    child.emit('close', 0)
    expect(observations.at(-1)?.verdict).toBe('live')
    child.emit('error', new Error('transport unavailable'))
    expect(observations.at(-1)?.verdict).toBe('unverifiable')
    child.emit('exit', 9, null)
    expect(observations.at(-1)).toMatchObject({
      verdict: 'exited',
      exitCode: 9,
      scope: 'app-server-child'
    })
    expect(new Set(observations.map((value) => value.incarnationId)).size).toBe(1)
    expect(fail).not.toHaveBeenCalled()
  })

  it('gives distinct incarnations to reused PIDs and routes observer failures to session failure', () => {
    const make = () => Object.assign(new EventEmitter(), { pid: 123 }) as ChildProcessHandle
    const first = vi.fn()
    const second = vi.fn()
    observeCodexProcess(make(), first, vi.fn())()
    observeCodexProcess(make(), second, vi.fn())()
    expect(first.mock.calls[0][0].incarnationId).not.toBe(second.mock.calls[0][0].incarnationId)
    const fail = vi.fn()
    observeCodexProcess(
      make(),
      () => {
        throw new Error('persist failed')
      },
      fail
    )()
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: 'persist failed' }))
  })
})
