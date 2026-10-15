import {
  runCodexAppServerSession,
  type CodexAppServerInvocation,
  type CodexAppServerRpc
} from './codex-app-server-session'
import { resolveOwnedProcessLauncherArtifact } from './codex-owned-launcher-identity'
import { runOwnedCodexSession } from './codex-owned-process-transport'

export async function runManagedCodexSession<T>(
  invocation: CodexAppServerInvocation,
  body: (rpc: CodexAppServerRpc) => Promise<T>
): Promise<T> {
  if (process.platform !== 'win32') {
    return runCodexAppServerSession(invocation, body)
  }
  const identity = resolveOwnedProcessLauncherArtifact()
  if (!identity) {
    throw new Error('Trusted Windows owned-process launcher artifact is unavailable')
  }
  return runOwnedCodexSession(identity, invocation, body)
}
