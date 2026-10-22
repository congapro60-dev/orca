import type {
  DailyDriverProject,
  DailyDriverWorkspace
} from '../../../../shared/daily-driver-contract'
import { translate } from '@/i18n/i18n'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

const label = (key: string, fallback: string): string => translate(`dailyDriver.${key}`, fallback)

export function DailyDriverWorkspacePicker({
  projects,
  project,
  workspace,
  projectId,
  workspaceId,
  onProjectChange,
  onWorkspaceChange
}: {
  projects: DailyDriverProject[]
  project: DailyDriverProject | undefined
  workspace: DailyDriverWorkspace | undefined
  projectId: string
  workspaceId: string
  onProjectChange: (id: string) => void
  onWorkspaceChange: (id: string) => void
}): React.JSX.Element {
  return (
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
            <Select value={projectId} onValueChange={onProjectChange}>
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
              <Select value={workspaceId} onValueChange={onWorkspaceChange}>
                <SelectTrigger id="orca-workspace" className="w-full min-w-0 [&>span]:truncate">
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
  )
}
