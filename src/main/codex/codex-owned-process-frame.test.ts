import { describe, expect, it } from 'vitest'
import { OwnedProcessFrameParser } from './codex-owned-process-frame'

const frame = (kind: string, data: string) =>
  JSON.stringify({ kind, data: Buffer.from(data).toString('base64') })

describe('Owned Codex process framed protocol', () => {
  it('preserves Unicode split between data frames and keeps stream decoders separate', () => {
    const parser = new OwnedProcessFrameParser()
    const bytes = Buffer.from('Tiếng Việt')
    const data = (kind: string, bytes: Buffer) =>
      JSON.stringify({ kind, data: bytes.toString('base64') })
    parser.feed(
      `${data('stdout', bytes.subarray(0, 3))}\n${frame('stderr', 'warning')}\n${data('stdout', bytes.subarray(3))}\n`
    )
    parser.feed(
      '{"kind":"jobExited","rootPid":12,"activeProcesses":0,"totalProcesses":1,"childExitCode":0}\n'
    )
    expect(parser.result().stdout).toBe('Tiếng Việt')
    expect(parser.result().stderr).toBe('warning')
  })

  it('rejects aggregate overflow, invalid UTF-8 and proof after a parser error', () => {
    const parser = new OwnedProcessFrameParser(8)
    parser.feed(`${frame('stdout', '12345678')}\n`)
    expect(() => parser.feed(`${frame('stderr', '9')}\n`)).toThrow(/aggregate bound/)
    expect(() =>
      parser.feed(
        '{"kind":"jobExited","rootPid":12,"activeProcesses":0,"totalProcesses":1,"childExitCode":0}\n'
      )
    ).toThrow(/aggregate bound/)
    expect(() => parser.finish()).toThrow(/aggregate bound/)
    const unicode = new OwnedProcessFrameParser()
    unicode.feed('{"kind":"stdout","data":"ww=="}\n')
    expect(() =>
      unicode.feed(
        '{"kind":"jobExited","rootPid":12,"activeProcesses":0,"totalProcesses":1,"childExitCode":0}\n'
      )
    ).toThrow()
    expect(() => unicode.finish()).toThrow()
    expect(() => new OwnedProcessFrameParser().feed('x'.repeat(32769))).toThrow(/buffer exceeds/)
  })
  it('separates spoofable child data from launcher proof across split UTF-8 chunks', () => {
    const parser = new OwnedProcessFrameParser()
    const childSpoof = JSON.stringify({ kind: 'jobExited', activeProcesses: 99 })
    const wire = `${frame('stdout', `${childSpoof}\nTiếng Việt`)}\n${frame('stderr', 'warning')}\n${JSON.stringify({ kind: 'jobExited', rootPid: 12, activeProcesses: 0, totalProcesses: 2, childExitCode: 7 })}\n`
    for (const chunk of [...wire].map((char) => char)) {
      parser.feed(chunk)
    }
    const result = parser.result()
    expect(result.stdout).toContain('jobExited')
    expect(result.stdout).toContain('Tiếng Việt')
    expect(result.stderr).toBe('warning')
    expect(result.proof.childExitCode).toBe(7)
  })

  it('requires one valid proof and rejects duplicate, partial, oversized and malformed frames', () => {
    const valid = JSON.stringify({
      kind: 'jobExited',
      rootPid: 12,
      activeProcesses: 0,
      totalProcesses: 1,
      childExitCode: 0
    })
    expect(() => new OwnedProcessFrameParser().result()).toThrow(/without containment/)
    const duplicate = new OwnedProcessFrameParser()
    expect(() => duplicate.feed(`${valid}\n${valid}\n`)).toThrow(/Duplicate/)
    const partial = new OwnedProcessFrameParser()
    partial.feed(valid.slice(0, 10))
    expect(() => partial.finish()).toThrow(/partial/)
    const malformed = new OwnedProcessFrameParser()
    expect(() => malformed.feed('{"kind":"stdout","data":"%%%"}\n')).toThrow(/base64/)
    const invalidProof = new OwnedProcessFrameParser()
    expect(() =>
      invalidProof.feed(
        `${JSON.stringify({ kind: 'jobExited', rootPid: 12, activeProcesses: 1, totalProcesses: 1, childExitCode: 0 })}\n`
      )
    ).toThrow()
    const afterProof = new OwnedProcessFrameParser()
    expect(() => afterProof.feed(`${valid}\n${frame('stdout', 'late')}\n`)).toThrow(
      /after containment/
    )
  })
})
