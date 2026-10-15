export type CodexProcessObservation = {
  incarnationId: string
  pid: number | null
  scope: 'app-server-child' | 'owned-process-launcher'
  verdict: 'live' | 'unverifiable' | 'exited'
  observedAt: string
  exitCode: number | null
  signal: string | null
  treeVerdict?: 'exited' | 'unverifiable'
  ownedTree?: {
    protocol: 'orca-owned-process-v1'
    launcherSha256: string
    rootPid: number
    activeProcesses: 0
    totalProcesses: number
    childExitCode: number
  }
}
