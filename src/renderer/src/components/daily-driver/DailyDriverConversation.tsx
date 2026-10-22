import { Send, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DailyDriverSessionView } from '../../../../shared/daily-driver-contract'
import type { WorkItem } from '../../../../shared/control-core-contract'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { DailyDriverPermissionField } from './DailyDriverSessionPanel'

const label = (key: string, fallback: string): string => translate(`dailyDriver.${key}`, fallback)

export function DailyDriverConversation({
  view,
  item,
  busy,
  permissionMode,
  onPermissionChange,
  onSend,
  onTechnical
}: {
  view: DailyDriverSessionView | null
  item: WorkItem | null
  busy: boolean
  permissionMode: 'READ_ONLY' | 'WORKSPACE_WRITE'
  onPermissionChange: (value: 'READ_ONLY' | 'WORKSPACE_WRITE') => void
  onSend: (objective: string) => void
  onTechnical: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const messages = useMemo(() => {
    if (!view) {
      return []
    }
    type ChatRow = {
      id: string
      role: 'user' | 'assistant'
      text: string
      status: WorkItem['status']
    }
    const rows: ChatRow[] = []
    for (const entry of view.items) {
      if (entry.parentWorkItemId === null) {
        continue
      }
      rows.push({
        id: `user-${entry.workItemId}`,
        role: 'user',
        text: entry.objective,
        status: entry.status
      })
      const reply = view.itemResults?.[entry.workItemId]
      if (reply) {
        rows.push({
          id: `assistant-${entry.workItemId}`,
          role: 'assistant',
          text: reply,
          status: entry.status
        })
      }
    }
    return rows
  }, [view])
  const submit = () => {
    const value = draft.trim()
    if (!value || busy) {
      return
    }
    setDraft('')
    onSend(value)
  }
  return (
    <Card className="min-h-[620px] flex flex-col" data-testid="orca-chat-workspace">
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center justify-between gap-3">
          <span>{label('conversation', 'Conversation')}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {view
              ? `${label('session', 'Session')} · ${view.session.logicalWorkSessionId}`
              : label('newConversation', 'New conversation')}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <div
          className="scrollbar-sleek flex-1 space-y-4 overflow-y-auto rounded-md bg-muted/40 p-4"
          aria-live="polite"
        >
          {messages.length === 0 && (
            <p className="mx-auto max-w-lg py-16 text-center text-sm text-muted-foreground">
              {label(
                'chatEmpty',
                'Tell ORCA what you want done. ORCA will keep the task, runtime activity and evidence together.'
              )}
            </p>
          )}
          {messages.map((message) => (
            <div
              key={message.id}
              className={message.role === 'user' ? 'ml-auto max-w-[82%]' : 'mr-auto max-w-[90%]'}
            >
              <p className="mb-1 text-xs text-muted-foreground">
                {message.role === 'user' ? label('you', 'You') : 'ORCA · Codex'} ·{' '}
                {label(`state.${message.status}`, message.status)}
              </p>
              <div
                className={
                  message.role === 'user'
                    ? 'rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground'
                    : 'rounded-lg border border-border bg-card px-4 py-3 text-sm'
                }
              >
                <pre className="whitespace-pre-wrap break-words font-sans">{message.text}</pre>
              </div>
            </div>
          ))}
          {view && ['WAITING', 'RUNNING'].includes(item?.status ?? '') && (
            <div className="mr-auto rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
              {label('runtimeWorking', 'ORCA is receiving runtime progress…')}
              <div className="mt-2 space-y-1 font-mono text-xs">
                {view.events.slice(-5).map((event) => (
                  <div key={event.sequence}>
                    #{event.sequence} {event.type}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="space-y-3 border-t border-border pt-3">
          <Textarea
            data-testid="orca-chat-composer"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
            placeholder={label('chatPlaceholder', 'Describe what you want ORCA to do…')}
            maxLength={8000}
            rows={4}
            disabled={busy}
          />
          <div className="flex flex-wrap items-end justify-between gap-3">
            <DailyDriverPermissionField
              value={permissionMode}
              disabled={busy}
              onChange={onPermissionChange}
            />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onTechnical}>
                <Wrench /> {label('technicalView', 'Technical view')}
              </Button>
              <Button disabled={busy || !draft.trim()} onClick={submit}>
                <Send /> {label('send', 'Send')}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
