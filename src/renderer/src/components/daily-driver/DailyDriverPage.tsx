import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Play } from 'lucide-react'
import type {
  DailyDriverProject,
  DailyDriverSessionView
} from '../../../../shared/daily-driver-contract'
import type { LogicalWorkSession, WorkItem } from '../../../../shared/control-core-contract'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { DailyDriverSessionPanel } from './DailyDriverSessionPanel'

const LAST_PROJECT = 'orca.dailyDriver.project'
const LAST_SESSION = 'orca.dailyDriver.session'
const label = (key: string, fallback: string): string => translate(`dailyDriver.${key}`, fallback)

export default function DailyDriverPage(): React.JSX.Element {
  useTranslation()
  const [projects, setProjects] = useState<DailyDriverProject[]>([])
  const [projectId, setProjectId] = useState(() => localStorage.getItem(LAST_PROJECT) ?? '')
  const [workspaceId, setWorkspaceId] = useState('')
  const [sessions, setSessions] = useState<LogicalWorkSession[]>([])
  const [selected, setSelected] = useState<DailyDriverSessionView | null>(null)
  const [objective, setObjective] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const project = projects.find((row) => row.id === projectId)
  const workspace = project?.workspaces.find((row) => row.id === workspaceId)
  const item = useMemo<WorkItem | null>(
    () => selected?.items.find((row) => row.branchId === 'main') ?? null,
    [selected]
  )
  const itemStatus = item?.status
  const selectionGeneration = useRef(0)

  const showError = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause))
  }, [])

  const refresh = useCallback(async (sessionId: string) => {
    const generation = selectionGeneration.current
    const view = (await window.api.dailyDriver.call({
      method: 'open',
      sessionId
    })) as DailyDriverSessionView
    if (generation === selectionGeneration.current) {
      setSelected(view)
    }
    return view
  }, [])

  useEffect(() => {
    let active = true
    void window.api.dailyDriver
      .call({ method: 'projects' })
      .then((rows) => {
        if (!active) {
          return
        }
        const values = rows as DailyDriverProject[]
        setProjects(values)
        setProjectId((current) =>
          values.some((row) => row.id === current) ? current : (values[0]?.id ?? '')
        )
      })
      .catch(showError)
    return () => {
      active = false
    }
  }, [showError])

  useEffect(() => {
    setWorkspaceId((current) =>
      project?.workspaces.some((row) => row.id === current)
        ? current
        : (project?.workspaces[0]?.id ?? '')
    )
  }, [project])

  useEffect(() => {
    if (!projectId) {
      return
    }
    localStorage.setItem(LAST_PROJECT, projectId)
    selectionGeneration.current += 1
    setSelected(null)
    let active = true
    void window.api.dailyDriver
      .call({ method: 'sessions', projectId })
      .then((rows) => {
        if (!active) {
          return
        }
        const values = rows as LogicalWorkSession[]
        setSessions(values)
        const last = localStorage.getItem(LAST_SESSION)
        if (last && values.some((row) => row.logicalWorkSessionId === last)) {
          void refresh(last).catch(showError)
        } else {
          setSelected(null)
        }
      })
      .catch(showError)
    return () => {
      active = false
    }
  }, [projectId, refresh, showError])

  useEffect(() => {
    if (!projectId || !workspaceId) {
      return
    }
    let active = true
    void window.api.dailyDriver
      .call({ method: 'workspaceInfo', projectId, workspaceId })
      .then((result) => {
        if (!active) {
          return
        }
        const info = result as DailyDriverProject['workspaces'][number]
        setProjects((current) =>
          current.map((row) =>
            row.id !== projectId
              ? row
              : {
                  ...row,
                  workspaces: row.workspaces.map((work) => (work.id === workspaceId ? info : work))
                }
          )
        )
      })
      .catch(showError)
    return () => {
      active = false
    }
  }, [projectId, workspaceId, showError])

  useEffect(() => {
    const sessionId = selected?.session.logicalWorkSessionId
    if (!sessionId || !itemStatus || !['WAITING', 'RUNNING'].includes(itemStatus)) {
      return
    }
    const timer = setInterval(() => {
      void refresh(sessionId).catch(showError)
    }, 1500)
    return () => clearInterval(timer)
  }, [selected?.session.logicalWorkSessionId, itemStatus, refresh, showError])

  const chooseSession = async (id: string) => {
    selectionGeneration.current += 1
    setError('')
    localStorage.setItem(LAST_SESSION, id)
    await refresh(id)
  }

  const submit = async () => {
    if (!project || !workspace || !objective.trim()) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const created = (await window.api.dailyDriver.call({
        method: 'create',
        projectId: project.id,
        workspaceId: workspace.id,
        objective: objective.trim()
      })) as DailyDriverSessionView
      localStorage.setItem(LAST_SESSION, created.session.logicalWorkSessionId)
      setSelected(created)
      setSessions((current) => [created.session, ...current])
      setObjective('')
      const assigned = created.items.find((row) => row.branchId === 'main')!
      const started = (await window.api.dailyDriver.call({
        method: 'start',
        sessionId: created.session.logicalWorkSessionId,
        expectedRevision: assigned.revision
      })) as DailyDriverSessionView
      setSelected(started)
    } catch (cause) {
      showError(cause)
    } finally {
      setBusy(false)
    }
  }

  const act = async (method: 'cancel' | 'verify' | 'start') => {
    if (!selected || !item) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const reviewedResultHash =
        method === 'verify' && selected.result
          ? Array.from(
              new Uint8Array(
                await crypto.subtle.digest('SHA-256', new TextEncoder().encode(selected.result))
              )
            )
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join('')
          : ''
      const request =
        method === 'verify'
          ? {
              method: 'verify' as const,
              sessionId: selected.session.logicalWorkSessionId,
              expectedRevision: item.revision,
              reviewedResultHash
            }
          : method === 'start'
            ? {
                method: 'start' as const,
                sessionId: selected.session.logicalWorkSessionId,
                expectedRevision: item.revision
              }
            : { method: 'cancel' as const, sessionId: selected.session.logicalWorkSessionId }
      setSelected((await window.api.dailyDriver.call(request)) as DailyDriverSessionView)
    } catch (cause) {
      showError(cause)
    } finally {
      setBusy(false)
    }
  }

  const signIn = async () => {
    setBusy(true)
    setError('')
    try {
      await window.api.codexAccounts.add({ runtime: 'host' })
    } catch (cause) {
      showError(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main
      className="scrollbar-sleek flex-1 overflow-y-auto bg-background text-foreground p-6"
      data-testid="orca-daily-driver"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div>
          <h1 className="text-xl font-semibold">{label('title', 'ORCA Work')}</h1>
          <p className="text-sm text-muted-foreground">
            Codex · {label('readOnly', 'Read only — Codex cannot change files')}
          </p>
        </div>
        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive p-3 text-sm text-destructive"
          >
            {label('error', 'Action failed. Review the technical message and retry.')}{' '}
            <code className="block break-all pt-1 text-xs">{error}</code>
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>{label('project', 'Project')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {projects.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {label('noProject', 'Add a local project in ORCA to begin.')}
                </p>
              )}
              {projects.length > 0 && (
                <>
                  <Label htmlFor="orca-project">{label('project', 'Project')}</Label>
                  <Select value={projectId} onValueChange={setProjectId}>
                    <SelectTrigger id="orca-project">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((row) => (
                        <SelectItem key={row.id} value={row.id} data-project-id={row.id}>
                          {row.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Label htmlFor="orca-workspace">{label('workspace', 'Workspace')}</Label>
                  {project?.workspaces.length ? (
                    <Select value={workspaceId} onValueChange={setWorkspaceId}>
                      <SelectTrigger
                        id="orca-workspace"
                        className="w-full min-w-0 [&>span]:truncate"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {project.workspaces.map((row) => (
                          <SelectItem key={row.id} value={row.id} data-workspace-id={row.id}>
                            {row.name} · {row.path.split(/[\\/]/).at(-1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {label('noWorkspace', 'No local workspace is available.')}
                    </p>
                  )}
                  {workspace && (
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <p className="break-all font-mono">{workspace.path}</p>
                      <p>
                        {label('head', 'HEAD')}: {workspace.head ?? '—'} ·{' '}
                        {label('gitStatus', 'Git status')}:{' '}
                        {workspace.gitStatus === null
                          ? '—'
                          : workspace.gitStatus
                            ? label('dirty', 'Changes')
                            : label('clean', 'Clean')}
                      </p>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{label('newTask', 'New task')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Label htmlFor="orca-objective">{label('task', 'Task')}</Label>
              <Textarea
                id="orca-objective"
                autoFocus
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder={label('taskPlaceholder', 'Describe what Codex should do…')}
                maxLength={8000}
                rows={5}
              />
              <p className="text-xs text-muted-foreground">
                {label('permission', 'Permission')}: {label('readOnly', 'Read only')}
              </p>
              <Button
                onClick={() => void submit()}
                disabled={!workspace || !objective.trim() || busy}
              >
                {busy ? <Loader2 className="animate-spin" /> : <Play />}
                {label('start', 'Start')}
              </Button>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{label('sessions', 'Recent work')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {sessions.map((row) => (
              <Button
                key={row.logicalWorkSessionId}
                variant={
                  selected?.session.logicalWorkSessionId === row.logicalWorkSessionId
                    ? 'secondary'
                    : 'outline'
                }
                size="sm"
                onClick={() => void chooseSession(row.logicalWorkSessionId)}
              >
                {row.objective.slice(0, 90)}
              </Button>
            ))}
          </CardContent>
        </Card>
        {selected && item ? (
          <DailyDriverSessionPanel
            key={selected.executionId ?? selected.session.logicalWorkSessionId}
            view={selected}
            item={item}
            busy={busy}
            refresh={() => void refresh(selected.session.logicalWorkSessionId).catch(showError)}
            act={(method) => void act(method)}
            signIn={() => void signIn()}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {label('emptySession', 'Select a project and enter a task.')}
          </p>
        )}
      </div>
    </main>
  )
}
