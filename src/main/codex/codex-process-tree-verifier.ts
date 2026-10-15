import {
  readWindowsProcessTableFresh,
  type WindowsProcessRow
} from '../windows/windows-process-table'

export type ProcessTreeVerdict = 'exited' | 'unverifiable'
type ProcessReader = () => Promise<WindowsProcessRow[]>

function descendants(rows: WindowsProcessRow[], rootPid: number): Set<number> {
  const ids = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid)
        changed = true
      }
    }
  }
  return ids
}

/** A process-table census cannot prove absence of reparented or escaped descendants. */
export async function verifyCodexProcessTreeExited(
  rootPid: number | null,
  read: ProcessReader = readWindowsProcessTableFresh
): Promise<ProcessTreeVerdict> {
  if (!rootPid) {
    return 'unverifiable'
  }
  try {
    const rows = await read()
    if (!rows.some((row) => row.pid === process.pid)) {
      return 'unverifiable'
    }
    const tree = descendants(rows, rootPid)
    void tree
    return 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}
