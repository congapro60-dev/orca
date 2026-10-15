// Why: only an argv parse failure that names app-server proves the RPC surface
// is absent; unrelated stderr must remain transient rather than poison the cache.
export function stderrIndicatesMissingAppServer(stderrTail: string): boolean {
  return /^(?=.*\bapp-server\b).*(?:unrecognized subcommand|unexpected argument|invalid subcommand)/im.test(
    stderrTail
  )
}

export function isCodexRpcMethodNotFound(error: { code?: number; message?: string }): boolean {
  return error.code === -32601 || /method not found/i.test(error.message ?? '')
}

export function codexEarlyExitError(stderrTail: string): Error {
  if (stderrIndicatesMissingAppServer(stderrTail)) {
    return new Error(
      `codex CLI does not support the app-server subcommand: ${stderrTail.trim().slice(0, 400)}`
    )
  }
  return new Error(
    `codex app-server exited before completing the session${stderrTail ? `: ${stderrTail.trim().slice(0, 400)}` : ''}`
  )
}
