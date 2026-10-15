import { TextDecoder } from 'node:util'
import { z } from 'zod'

const MAX_FRAME_BYTES = 16384
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DataFrame = z
  .object({
    kind: z.enum(['stdout', 'stderr']),
    data: z.string().max(5464)
  })
  .strict()
const ProofFrame = z
  .object({
    kind: z.literal('jobExited'),
    rootPid: z.number().int().positive().max(0xffffffff),
    activeProcesses: z.literal(0),
    totalProcesses: z.number().int().positive().max(0xffffffff),
    childExitCode: z.number().int().nonnegative().max(0xffffffff)
  })
  .strict()
export type OwnedProcessProof = z.infer<typeof ProofFrame>

export class OwnedProcessFrameParser {
  private buffer = ''
  private proof: OwnedProcessProof | null = null
  private readonly output: { stdout: string; stderr: string } = { stdout: '', stderr: '' }
  private readonly decoders = {
    stdout: new TextDecoder('utf-8', { fatal: true }),
    stderr: new TextDecoder('utf-8', { fatal: true })
  }
  private bytes = 0
  private failure: Error | null = null

  constructor(
    private readonly outputLimit = MAX_OUTPUT_BYTES,
    private readonly onData?: (kind: 'stdout' | 'stderr', text: string) => void
  ) {
    if (!Number.isSafeInteger(outputLimit) || outputLimit < 1 || outputLimit > MAX_OUTPUT_BYTES) {
      throw new Error('Invalid owned process output bound')
    }
  }

  feed(chunk: string): void {
    if (this.failure) {
      throw this.failure
    }
    try {
      this.buffer += chunk
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line) {
          this.accept(line)
        }
      }
      if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES * 2) {
        throw new Error('Owned process frame buffer exceeds bound')
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error))
      throw this.failure
    }
  }

  finish(): OwnedProcessProof {
    if (this.failure) {
      throw this.failure
    }
    if (this.buffer.trim()) {
      throw new Error('Owned process stream ended with partial frame')
    }
    if (!this.proof) {
      throw new Error('Owned process stream ended without containment proof')
    }
    return { ...this.proof }
  }

  result(): { stdout: string; stderr: string; proof: OwnedProcessProof } {
    return { ...this.output, proof: this.finish() }
  }

  private accept(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
      throw new Error('Owned process frame exceeds bound')
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error('Owned process frame is not JSON')
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as { kind?: unknown }).kind === 'jobExited'
    ) {
      if (this.proof) {
        throw new Error('Duplicate owned process proof')
      }
      for (const key of ['stdout', 'stderr'] as const) {
        const tail = this.decoders[key].decode()
        this.output[key] += tail
        if (tail) {
          this.onData?.(key, tail)
        }
      }
      this.proof = ProofFrame.parse(value)
      return
    }
    const frame = DataFrame.parse(value)
    if (this.proof) {
      throw new Error('Owned process data arrived after containment proof')
    }
    const decoded = Buffer.from(frame.data, 'base64')
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data) ||
      decoded.toString('base64') !== frame.data
    ) {
      throw new Error('Owned process data frame is not valid base64')
    }
    const key = frame.kind === 'stdout' ? 'stdout' : 'stderr'
    this.bytes += decoded.length
    if (decoded.length > 4096 || this.bytes > this.outputLimit) {
      throw new Error('Owned process output exceeds aggregate bound')
    }
    const text = this.decoders[key].decode(decoded, { stream: true })
    this.output[key] += text
    if (text) {
      this.onData?.(key, text)
    }
  }
}
