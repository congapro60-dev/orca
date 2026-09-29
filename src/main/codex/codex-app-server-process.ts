import {
  spawnProcess,
  type ChildProcessHandle,
  type ProcessSpawnImplementation,
  type ProcessSpawnOptions
} from '../../shared/child-process/run-process'

export const spawnThroughProcessBoundary = ((
  program: string,
  args: string[],
  options: ProcessSpawnOptions
) =>
  spawnProcess({
    program,
    args,
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
    env: options.env,
    stdio: options.stdio,
    detached: options.detached
  })) as ProcessSpawnImplementation

export function killCodexAppServerProcessTree(
  child: Pick<ChildProcessHandle, 'pid' | 'kill'>,
  options: { platform?: NodeJS.Platform; spawnImpl?: ProcessSpawnImplementation } = {}
): void {
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl ?? spawnThroughProcessBoundary
  if (platform === 'win32' && child.pid) {
    try {
      // Kill wrappers and descendants together, not only the npm/cmd parent.
      const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      let fellBack = false
      const killDirectChild = (): void => {
        if (!fellBack) {
          fellBack = true
          child.kill('SIGKILL')
        }
      }
      killer.on('error', killDirectChild)
      killer.on('exit', (code) => {
        if (code !== 0) {
          killDirectChild()
        }
      })
      killer.unref()
      return
    } catch {
      // Direct-child fallback is best-effort, not proof that descendants exited.
    }
  }
  child.kill('SIGKILL')
}
