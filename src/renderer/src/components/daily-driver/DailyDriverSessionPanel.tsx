import { RotateCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { DailyDriverSessionView } from '../../../../shared/daily-driver-contract'
import type { WorkItem } from '../../../../shared/control-core-contract'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'

const label = (key: string, fallback: string): string => translate(`dailyDriver.${key}`, fallback)

export function DailyDriverSessionPanel({
  view,
  item,
  busy,
  refresh,
  act,
  signIn
}: {
  view: DailyDriverSessionView
  item: WorkItem
  busy: boolean
  refresh: () => void
  act: (method: 'cancel' | 'verify' | 'start') => void
  signIn: () => void
}): React.JSX.Element {
  const [accepted, setAccepted] = useState(false)
  const failedReason = view.events.toReversed().find((event) => event.type === 'WORK_FAILED')
    ?.payload.reason
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">{view.session.objective}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          {label(`state.${item.status}`, item.status)} · {view.executionId ?? '—'}
        </p>
        {view.elapsedMs !== null && (
          <p className="text-xs text-muted-foreground">
            {label('elapsed', 'Elapsed')}: {Math.floor(view.elapsedMs / 1000)}s
          </p>
        )}
        {item.status === 'READY_FOR_REVIEW' && (
          <p className="text-sm text-muted-foreground">
            {label('readyReview', 'Codex returned a result. Review evidence before verifying.')}
          </p>
        )}
        {item.status === 'BLOCKED' && (
          <p className="text-sm text-destructive">
            {label('blocked', 'Outcome uncertain. Reconcile before retry.')}
          </p>
        )}
        {item.status === 'FAILED' && (
          <p className="text-sm text-destructive">
            {String(view.runtimeError ?? failedReason ?? '')}
          </p>
        )}
        {item.status === 'FAILED' &&
          /sign-in|sign in|subscription/i.test(view.runtimeError ?? String(failedReason ?? '')) && (
            <Button variant="outline" disabled={busy} onClick={signIn}>
              {label('signIn', 'Sign in to Codex')}
            </Button>
          )}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refresh}>
            <RotateCw />
            {label('refresh', 'Refresh')}
          </Button>
          {['WAITING', 'RUNNING'].includes(item.status) && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => act('cancel')}>
              {label('cancel', 'Cancel task')}
            </Button>
          )}
          {['FAILED', 'CANCELLED'].includes(item.status) && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => act('start')}>
              {label('retry', 'Retry task')}
            </Button>
          )}
        </div>
        <div>
          <h2 className="text-sm font-medium">{label('result', 'Result')}</h2>
          <pre
            data-testid="orca-task-result"
            className="scrollbar-sleek max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm"
          >
            {view.result ?? '—'}
          </pre>
        </div>
        {view.evidence && (
          <div className="text-xs text-muted-foreground">
            <h2 className="font-medium">{label('evidence', 'Basic evidence')}</h2>
            <p>
              {label('runtime', 'Runtime')}: Codex · {label('executionId', 'Execution ID')}:{' '}
              {view.evidence.executionId}
            </p>
            <p>
              Task: {view.evidence.taskId} · Dispatch: {view.evidence.dispatchId}
            </p>
            <p>
              Sandbox: {view.evidence.sandbox} · Approval: {view.evidence.approval}
            </p>
          </div>
        )}
        {item.status === 'READY_FOR_REVIEW' && (
          <div className="space-y-3 border-t border-border pt-3">
            <p className="text-sm text-muted-foreground">
              {label(
                'reviewGuidance',
                'Compare the result with your task before accepting it. Runtime completion alone does not prove the task is correct.'
              )}
            </p>
            <div className="flex items-start gap-2">
              <Checkbox
                id="orca-review-accept"
                checked={accepted}
                onCheckedChange={(checked) => setAccepted(checked === true)}
              />
              <label htmlFor="orca-review-accept" className="text-sm">
                {label('reviewConfirm', 'I reviewed this result and accept it as meeting my task.')}
              </label>
            </div>
            <Button
              disabled={busy || !accepted || !view.result || !view.evidence?.resultStored}
              onClick={() => act('verify')}
            >
              <ShieldCheck />
              {label('verify', 'Verify result')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
