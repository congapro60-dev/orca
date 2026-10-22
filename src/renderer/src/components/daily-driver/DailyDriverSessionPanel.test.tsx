// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WorkItem } from '../../../../shared/control-core-contract'
import type { DailyDriverSessionView } from '../../../../shared/daily-driver-contract'
import { DailyDriverSessionPanel } from './DailyDriverSessionPanel'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
afterEach(cleanup)

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
          permissionMode: 'READ_ONLY',
          rootWorkItemId: 'root',
          runId: 'run',
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        },
        items: [item],
        events: [],
        result: null,
        itemResults: {},
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

it('requires explicit successful-command selection, resets acceptance on selection change', () => {
  const ready = { ...item, status: 'READY_FOR_REVIEW' as const }
  const view: DailyDriverSessionView = {
    session: {
      logicalWorkSessionId: 'session',
      projectId: 'project',
      worktree: '/workspace',
      objective: 'Fix',
      status: 'ACTIVE',
      permissionMode: 'WORKSPACE_WRITE',
      rootWorkItemId: 'root',
      runId: 'run',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    },
    items: [ready],
    events: [],
    result: 'Result',
    itemResults: { [item.workItemId]: 'Result' },
    executionId: item.executionId,
    runtimeStatus: 'COMPLETED',
    runtimeError: null,
    elapsedMs: null,
    evidence: {
      executionId: item.executionId!,
      taskId: 'task',
      dispatchId: 'dispatch',
      sandbox: 'WORKSPACE_WRITE',
      approval: 'never',
      resultStored: true
    },
    reviewEvidence: {
      contentHash: 'a'.repeat(64),
      observed: null,
      commands: [
        { itemId: 'test', command: 'node --test', exitCode: 0, status: 'completed' },
        { itemId: 'bad', command: 'node --test bad.js', exitCode: 1, status: 'completed' }
      ]
    }
  }
  const act = vi.fn()
  const { rerender } = render(
    <DailyDriverSessionPanel
      key="first"
      view={view}
      item={ready}
      busy={false}
      refresh={() => {}}
      act={act}
      signIn={() => {}}
    />
  )
  const verify = screen.getByRole('button', { name: 'Verify result' }) as HTMLButtonElement
  const accepted = screen.getByRole('checkbox', { name: /I reviewed/ })
  const test = screen.getByRole('checkbox', { name: 'node --test · completed · exit 0' })
  expect((screen.getByRole('checkbox', { name: /bad.js/ }) as HTMLButtonElement).disabled).toBe(
    true
  )
  expect(verify.disabled).toBe(true)
  fireEvent.click(accepted)
  expect(verify.disabled).toBe(true)
  fireEvent.click(test)
  expect(accepted.getAttribute('data-state')).toBe('unchecked')
  expect(verify.disabled).toBe(true)
  fireEvent.click(accepted)
  expect(verify.disabled).toBe(false)
  fireEvent.click(verify)
  expect(act).toHaveBeenCalledWith('verify', ['test'])
  rerender(
    <DailyDriverSessionPanel
      key="changed-evidence"
      view={view}
      item={ready}
      busy={false}
      refresh={() => {}}
      act={act}
      signIn={() => {}}
    />
  )
  expect(
    (screen.getByRole('button', { name: 'Verify result' }) as HTMLButtonElement).disabled
  ).toBe(true)
  expect(screen.getByRole('checkbox', { name: /I reviewed/ }).getAttribute('data-state')).toBe(
    'unchecked'
  )
})
