import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DailyDriverProject,
  DailyDriverSessionView
} from '../../../../shared/daily-driver-contract'
import type { LogicalWorkSession, WorkItem } from '../../../../shared/control-core-contract'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DailyDriverSessionPanel } from './DailyDriverSessionPanel'
import { DailyDriverConversation } from './DailyDriverConversation'
import { DailyDriverWorkspacePicker } from './DailyDriverWorkspacePicker'

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
  const [permissionMode, setPermissionMode] = useState<'READ_ONLY' | 'WORKSPACE_WRITE'>('READ_ONLY')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const setActiveView = useAppStore((state) => state.setActiveView)
  const project = projects.find((row) => row.id === projectId)
  const workspace = project?.workspaces.find((row) => row.id === workspaceId)
  const item = useMemo<WorkItem | null>(
    () => selected?.items.toReversed().find((row) => row.parentWorkItemId !== null) ?? null,
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
    if (!activeWorktreeId) {
      return
    }
    const activeProject = projects.find((candidate) =>
      candidate.workspaces.some((workspaceRow) => workspaceRow.id === activeWorktreeId)
    )
    const activeWorkspace = activeProject?.workspaces.find((row) => row.id === activeWorktreeId)
    if (activeProject && activeWorkspace) {
      setProjectId(activeProject.id)
      setWorkspaceId(activeWorkspace.id)
    }
  }, [activeWorktreeId, projects])

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

  const submit = async (instruction: string) => {
    if (!project || !workspace || !instruction.trim()) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const created = (await window.api.dailyDriver.call({
        method: 'create',
        projectId: project.id,
        workspaceId: workspace.id,
        objective: instruction.trim(),
        permissionMode
      })) as DailyDriverSessionView
      localStorage.setItem(LAST_SESSION, created.session.logicalWorkSessionId)
      setSelected(created)
      setSessions((current) => [created.session, ...current])
      const assigned = created.items.toReversed().find((row) => row.parentWorkItemId !== null)
      if (!assigned) {
        throw new Error('Logical session has no work item')
      }
      const started = (await window.api.dailyDriver.call({
        method: 'start',
        sessionId: created.session.logicalWorkSessionId,
        expectedRevision: assigned.revision
      })) as DailyDriverSessionView
      setSelected(started)
      setPermissionMode(started.session.permissionMode)
    } catch (cause) {
      showError(cause)
    } finally {
      setBusy(false)
    }
  }

  const sendConversationMessage = async (instruction: string) => {
    if (!selected) {
      await submit(instruction)
      return
    }
    setBusy(true)
    setError('')
    try {
      setSelected(
        (await window.api.dailyDriver.call({
          method: 'followup',
          sessionId: selected.session.logicalWorkSessionId,
          objective: instruction,
          permissionMode: selected.session.permissionMode
        })) as DailyDriverSessionView
      )
    } catch (cause) {
      showError(cause)
    } finally {
      setBusy(false)
    }
  }

  const act = async (
    method: 'cancel' | 'verify' | 'start' | 'reconcile',
    testCommandItemIds?: string[]
  ) => {
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
        method === 'reconcile'
          ? { method: 'reconcile' as const, sessionId: selected.session.logicalWorkSessionId }
          : method === 'verify'
            ? {
                method: 'verify' as const,
                sessionId: selected.session.logicalWorkSessionId,
                expectedRevision: item.revision,
                reviewedResultHash,
                reviewedEvidenceHash: selected.reviewEvidence?.contentHash,
                testCommandItemIds
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
            {label(
              'chatSubtitle',
              'Chat-first workspace · Control Core keeps task state and evidence.'
            )}
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
          <DailyDriverWorkspacePicker
            projects={projects}
            project={project}
            workspace={workspace}
            projectId={projectId}
            workspaceId={workspaceId}
            onProjectChange={setProjectId}
            onWorkspaceChange={setWorkspaceId}
          />
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              {label(
                'chatProjectHint',
                'Choose a project and workspace. Send instructions in the conversation below.'
              )}
            </p>
            {selected && (
              <p>
                {label('runtime', 'Runtime')}: Codex · {label('permission', 'Permission')}:{' '}
                {selected.session.permissionMode === 'WORKSPACE_WRITE'
                  ? label('workspaceWrite', 'Workspace write')
                  : label('readOnly', 'Read only')}
              </p>
            )}
          </div>
        </div>
        <DailyDriverConversation
          view={selected}
          item={item}
          busy={busy || !workspace}
          permissionMode={selected?.session.permissionMode ?? permissionMode}
          onPermissionChange={selected ? () => {} : setPermissionMode}
          onSend={(instruction) => void sendConversationMessage(instruction)}
          onTechnical={() => setActiveView('terminal')}
        />
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
            key={`${selected.executionId ?? selected.session.logicalWorkSessionId}:${selected.reviewEvidence?.contentHash ?? ''}`}
            view={selected}
            item={item}
            busy={busy}
            refresh={() => void refresh(selected.session.logicalWorkSessionId).catch(showError)}
            act={(method, ids) => void act(method, ids)}
            signIn={() => void signIn()}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {label('emptySession', 'Select a project and send an instruction.')}
          </p>
        )}
      </div>
    </main>
  )
}
