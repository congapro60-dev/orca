import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexRuntimeReceipt } from '../../shared/codex-runtime-contract'
import type { DailyDriverSessionView } from '../../shared/daily-driver-contract'
import { coreFixture } from './control-core-test-fixture'
import { ControlEvidenceStore } from './control-evidence-store'
import { ControlWorkStore } from './control-work-store'
import { CodexExecutionStore } from '../runtime/orchestration/codex-execution-store'

const deps = vi.hoisted(() => ({ supervisor: {} as Record<string, unknown> }))
vi.mock('../codex/codex-runtime-installation', () => ({
  resolveCodexRuntimeExecutable: () => 'fixture-codex.exe'
}))
vi.mock('../codex/codex-home-paths', () => ({ getOrcaManagedCodexHomePath: () => 'fixture-home' }))
vi.mock('../runtime/rpc/methods/orchestration-codex-execution', () => ({
  getCodexExecutionSupervisor: () => deps.supervisor
}))
import { DailyDriverHost } from './daily-driver-host'

const fixtures: ReturnType<typeof coreFixture>[] = []
afterEach(() => fixtures.splice(0).forEach((f) => f.dispose()))

async function fixture(permissionMode: 'READ_ONLY' | 'WORKSPACE_WRITE' = 'WORKSPACE_WRITE') {
  const f = coreFixture()
  fixtures.push(f)
  const worktree = join(f.directory, 'workspace')
  mkdirSync(worktree)
  const source = join(worktree, 'value.txt')
  writeFileSync(source, 'before')
  const native = new CodexExecutionStore(f.db, 'fixture-epoch')
  deps.supervisor = {
    start: async (taskId: string) =>
      native.accept(taskId, randomUUID(), worktree, undefined, permissionMode),
    get: (id: string) => new CodexExecutionStore(f.db, 'fixture-epoch').require(id),
    result: async (id: string) => {
      const current = native.require(id)
      if (current.status === 'STARTING') {
        const receipt: CodexRuntimeReceipt = {
          executionId: id,
          requestedRuntime: 'codex',
          resolvedExecutablePath: 'fixture-codex.exe',
          resolvedExecutableVersion: 'fixture',
          runtimeProtocol: 'codex-app-server-jsonrpc-v2',
          requestedModel: null,
          resolvedModel: null,
          actualModel: 'UNKNOWN_UNVERIFIED',
          effectiveSandbox: permissionMode,
          approvalPolicy: 'never',
          worktree,
          codexHome: 'fixture-home',
          threadId: 'fixture-thread',
          turnId: 'fixture-turn'
        }
        native.save({ receipt, status: 'RUNNING', text: '', error: null })
        if (permissionMode === 'WORKSPACE_WRITE') {
          writeFileSync(source, 'after')
        }
        native.save({
          receipt,
          status: 'COMPLETED',
          text: 'Fixture result, not live proof',
          error: null,
          commands: [
            { itemId: 'test', command: 'node --test', exitCode: 0, status: 'completed' },
            {
              itemId: 'failed',
              command: 'node --test failing.test.js',
              exitCode: 1,
              status: 'completed'
            }
          ]
        })
      }
      return native.require(id)
    },
    cancel: vi.fn()
  }
  const runtime = {
    getOrchestrationDb: () => f.db,
    listRepos: () => [{ id: 'repo', kind: 'folder' }],
    listProjects: () => [{ id: 'project', displayName: 'Fixture', sourceRepoIds: ['repo'] }],
    listManagedWorktrees: async () => ({
      worktrees: [
        { id: 'workspace', repoId: 'repo', git: { path: worktree }, displayName: 'Fixture' }
      ]
    })
  }
  const host = new DailyDriverHost(runtime as never)
  const created = (await host.call({
    method: 'create',
    projectId: 'project',
    workspaceId: 'workspace',
    objective: 'Fixture validation',
    permissionMode
  })) as DailyDriverSessionView
  const sessionId = created.session.logicalWorkSessionId
  const main = created.items.find((item) => item.branchId === 'main')!
  await host.call({ method: 'start', sessionId, expectedRevision: main.revision })
  let view: DailyDriverSessionView = created
  await vi.waitFor(async () => {
    view = (await host.call({ method: 'open', sessionId })) as DailyDriverSessionView
    expect(
      view.items.find((item) => item.branchId === 'main')?.status,
      JSON.stringify(view.events)
    ).toBe('READY_FOR_REVIEW')
    expect(view.reviewEvidence).toBeTruthy()
  })
  const request = {
    method: 'verify' as const,
    sessionId,
    expectedRevision: view.items.find((item) => item.branchId === 'main')!.revision,
    reviewedResultHash: createHash('sha256').update(view.result!).digest('hex'),
    reviewedEvidenceHash: view.reviewEvidence!.contentHash,
    testCommandItemIds: permissionMode === 'WORKSPACE_WRITE' ? ['test'] : undefined
  }
  return { f, host, runtime, source, view, request, itemId: main.workItemId }
}

describe('Daily Driver immutable owner-reviewed command evidence', () => {
  it('rejects stale/foreign/failed selection, then atomically appends verified evidence across reopen', async () => {
    const { f, host, runtime, request, itemId } = await fixture()
    const store = new ControlEvidenceStore(new ControlWorkStore(f.db))
    const original = store.list(itemId)[0]!
    expect(original.tests).toBeNull()
    for (const fault of [
      { reviewedEvidenceHash: '0'.repeat(64) },
      { reviewedEvidenceHash: undefined },
      { testCommandItemIds: [] },
      { testCommandItemIds: ['foreign'] },
      { testCommandItemIds: ['failed'] },
      { testCommandItemIds: ['test', 'test'] }
    ]) {
      await expect(host.call({ ...request, ...fault })).rejects.toThrow()
      expect(store.list(itemId)).toEqual([original])
      expect(new ControlWorkStore(f.db).item(itemId).status).toBe('READY_FOR_REVIEW')
    }
    f.db.db.exec(`CREATE TRIGGER reject_review BEFORE INSERT ON control_evidence_records
      WHEN json_extract(NEW.snapshot,'$.verificationStatus')='VERIFIED'
      BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`)
    await expect(host.call(request)).rejects.toThrow(/fixture rollback/)
    expect(store.list(itemId)).toEqual([original])
    expect(new ControlWorkStore(f.db).item(itemId).status).toBe('READY_FOR_REVIEW')
    f.db.db.exec('DROP TRIGGER reject_review')
    const verified = (await host.call(request)) as DailyDriverSessionView
    expect(verified.session.status).toBe('COMPLETED')
    const record = store.list(itemId)[0]!
    expect(record.verificationStatus).toBe('VERIFIED')
    expect(record.tests).toEqual([{ commandItemId: 'test', command: 'node --test', exitCode: 0 }])
    expect(record.sourceEvidenceRefs).toContain('owner-selected-runtime-tests')
    expect(record.sourceEvidenceRefs).toContain(`evidence:${original.evidenceId}`)
    expect(store.get(original.evidenceId)).toEqual(original)
    f.reopen()
    const reopened = (await new DailyDriverHost(runtime as never).call({
      method: 'open',
      sessionId: request.sessionId
    })) as DailyDriverSessionView
    expect(reopened.session.status).toBe('COMPLETED')
    expect(reopened.reviewEvidence?.contentHash).toBe(record.contentHash)
    expect(new ControlEvidenceStore(new ControlWorkStore(f.db)).get(original.evidenceId)).toEqual(
      original
    )
  })

  it.each(['READ_ONLY', 'WORKSPACE_WRITE'] as const)(
    'refuses workspace drift before %s verification',
    async (mode) => {
      const { f, host, source, request, itemId } = await fixture(mode)
      writeFileSync(source, 'unreviewed change')
      await expect(host.call(request)).rejects.toThrow(/Workspace changed/)
      expect(new ControlWorkStore(f.db).item(itemId).status).toBe('READY_FOR_REVIEW')
      expect(new ControlEvidenceStore(new ControlWorkStore(f.db)).list(itemId)).toHaveLength(1)
    }
  )

  it('retains READ_ONLY verification without a test selection', async () => {
    const { host, request } = await fixture('READ_ONLY')
    expect(((await host.call(request)) as DailyDriverSessionView).session.status).toBe('COMPLETED')
  })
})
