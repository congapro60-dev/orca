import { createHash } from 'node:crypto'
import { redactString } from '../observability/redactor'

export function isSafeMemoryReference(value: string): boolean {
  if (redactString(value) !== value || /[?#@%]/.test(value)) {
    return false
  }
  try {
    const url = new URL(value, 'https://memory-reference.invalid')
    if (url.username || url.password) {
      return false
    }
  } catch {
    return false
  }
  return true
}

/** Keep source evidence intact; memory receives only an opaque fingerprint for sensitive locators. */
export function safeMemoryReference(value: string): string {
  return isSafeMemoryReference(value)
    ? value
    : `redacted-ref:sha256:${createHash('sha256').update(value).digest('hex')}`
}
