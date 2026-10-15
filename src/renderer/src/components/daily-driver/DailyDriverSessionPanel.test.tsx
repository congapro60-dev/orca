import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WorkItem } from '../../../../shared/control-core-contract'
import type { DailyDriverSessionView } from '../../../../shared/daily-driver-contract'
import { DailyDriverSessionPanel } from './DailyDriverSessionPanel'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const item: WorkItem = {
  workItemId: 'item',
  logicalWorkSessionId: 'session',
  parentWorkItemId: 'root',
  branchId: 'main',
  objective: 'Recover',
  status: 'BLOCKED',
  dependsOn: [],
  assignedRuntime: 'codex',
  artifactRefs: [],
  evidenceRefs: [],
  doneWhen: [],
  constraints: [],
  nativeTaskId: 'task',
  executionId: 'source-execution',
  cancelRequested: false,
  revision: 3,
  createdAt: '2026-10-15T00:00:00Z',
  updatedAt: '2026-10-15T00:00:00Z'
}

describe('Daily Driver blocked recovery action', () => {
  it.each([null, 'NEEDS_RECONCILE', 'STALE_CHECKPOINT', 'ELIGIBLE'] as const)(
    'offers retry only after an ELIGIBLE decision: %s',
    (status) => {
      const view: DailyDriverSessionView = {
        session: {
          logicalWorkSessionId: 'session',
          projectId: 'project',
          worktree: '/workspace',
          objective: 'Recover',
          status: 'ACTIVE',
          rootWorkItemId: 'root',
          runId: 'run',
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        },
        items: [item],
        events: [],
        result: null,
        executionId: item.executionId,
        runtimeStatus: 'OUTCOME_UNKNOWN',
        runtimeError: null,
        elapsedMs: null,
        evidence: null,
        recovery: status
          ? {
              status,
              processVerdict: status === 'ELIGIBLE' ? 'exited' : 'unverifiable',
              reason: 'Host decision'
            }
          : null
      }
      const act = vi.fn()
      const markup = renderToStaticMarkup(
        <DailyDriverSessionPanel
          view={view}
          item={item}
          busy={false}
          refresh={() => {}}
          act={act}
          signIn={() => {}}
        />
      )
      expect(markup.includes('Retry task')).toBe(status === 'ELIGIBLE')
      expect(markup).toContain('Check recovery state')
      if (status) {
        expect(markup).toContain('role="status"')
        expect(markup).toContain('Host decision')
      }
      expect(act).not.toHaveBeenCalled()
    }
  )
})
