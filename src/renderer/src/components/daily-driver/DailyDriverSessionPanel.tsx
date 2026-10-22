import { RotateCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { DailyDriverSessionView } from '../../../../shared/daily-driver-contract'
import type { WorkItem } from '../../../../shared/control-core-contract'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

const label = (key: string, fallback: string): string => translate(`dailyDriver.${key}`, fallback)

export function DailyDriverPermissionField({
  value,
  disabled,
  onChange
}: {
  value: 'READ_ONLY' | 'WORKSPACE_WRITE'
  disabled: boolean
  onChange: (value: 'READ_ONLY' | 'WORKSPACE_WRITE') => void
}) {
  return (
    <>
      <Label htmlFor="orca-permission">{label('permission', 'Permission')}</Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) =>
          onChange(next === 'WORKSPACE_WRITE' ? 'WORKSPACE_WRITE' : 'READ_ONLY')
        }
      >
        <SelectTrigger id="orca-permission">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="READ_ONLY">{label('readOnly', 'Read only')}</SelectItem>
          <SelectItem value="WORKSPACE_WRITE">
            {label('workspaceWrite', 'Workspace write')}
          </SelectItem>
        </SelectContent>
      </Select>
    </>
  )
}

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
  act: (method: 'cancel' | 'verify' | 'start' | 'reconcile', testCommandItemIds?: string[]) => void
  signIn: () => void
}): React.JSX.Element {
  const [accepted, setAccepted] = useState(false)
  const [testIds, setTestIds] = useState<string[]>([])
  const writeMode = view.session.permissionMode === 'WORKSPACE_WRITE'
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
        <p className="text-xs text-muted-foreground">
          {label('permission', 'Permission')}:{' '}
          {label(
            view.session.permissionMode === 'WORKSPACE_WRITE' ? 'workspaceWrite' : 'readOnly',
            view.session.permissionMode === 'WORKSPACE_WRITE' ? 'Workspace write' : 'Read only'
          )}
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
        {item.status === 'BLOCKED' && view.recovery?.status !== 'ELIGIBLE' && (
          <p className="text-sm text-destructive">
            {label('blocked', 'Outcome uncertain. Reconcile before retry.')}
          </p>
        )}
        {view.recovery && (
          <div
            role="status"
            className="space-y-2 rounded-md border border-border bg-muted p-3 text-sm"
          >
            <p>
              {label('recovery', 'Recovery')}:{' '}
              {label(`recoveryState.${view.recovery.status}`, view.recovery.status)}
            </p>
            <p className="text-muted-foreground">{view.recovery.reason}</p>
            <p>
              {label(
                'recoveryGuidance',
                'This check does not start work. Do not retry while the previous execution is unverified.'
              )}
            </p>
          </div>
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
          {['BLOCKED', 'FAILED', 'CANCELLED'].includes(item.status) && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => act('reconcile')}>
              {label('reconcile', 'Check recovery state')}
            </Button>
          )}
          {['FAILED', 'CANCELLED', 'BLOCKED'].includes(item.status) &&
            (view.recovery?.status === 'ELIGIBLE' ||
              (!view.recovery && item.status !== 'BLOCKED')) && (
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
            {writeMode && (
              <fieldset disabled={busy} className="space-y-2">
                <legend className="text-sm font-medium">
                  {label('validationCommands', 'Select commands you reviewed as tests')}
                </legend>
                <p className="text-xs text-muted-foreground">
                  {label(
                    'validationHelp',
                    'Captured runtime commands, not an independent ORCA test run. Select only tests that validate the final changes.'
                  )}
                </p>
                <pre className="scrollbar-sleek max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {view.reviewEvidence?.observed?.changedFiles.join('\n') || '—'}
                  {'\n'}Diff SHA-256: {view.reviewEvidence?.observed?.diffHash ?? '—'}
                </pre>
                {!view.reviewEvidence?.commands?.length && (
                  <p className="text-sm">
                    {label(
                      'noValidationCommands',
                      'No captured validation commands. Verification is blocked.'
                    )}
                  </p>
                )}
                {view.reviewEvidence?.commands?.map((command, index) => (
                  <div key={command.itemId} className="flex items-start gap-2">
                    <Checkbox
                      id={`orca-test-${index}`}
                      disabled={
                        command.status !== 'completed' ||
                        command.exitCode !== 0 ||
                        !command.command.trim() ||
                        command.command.length >= 2048
                      }
                      checked={testIds.includes(command.itemId)}
                      onCheckedChange={(checked) => {
                        setAccepted(false)
                        setTestIds((ids) =>
                          checked === true
                            ? [...ids, command.itemId]
                            : ids.filter((id) => id !== command.itemId)
                        )
                      }}
                    />
                    <label
                      htmlFor={`orca-test-${index}`}
                      className="min-w-0 break-all font-mono text-xs"
                    >
                      {command.command} · {command.status} · exit {command.exitCode ?? '?'}
                    </label>
                  </div>
                ))}
              </fieldset>
            )}
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
              disabled={
                busy ||
                !accepted ||
                !view.result ||
                !view.evidence?.resultStored ||
                (writeMode && (!view.reviewEvidence || !testIds.length))
              }
              onClick={() => act('verify', writeMode ? testIds : undefined)}
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
