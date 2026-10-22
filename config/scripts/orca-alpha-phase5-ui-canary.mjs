import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

const require = createRequire(import.meta.url)
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const evidence = 'C:\\Users\\ADMIN\\Documents\\Codex\\orca-alpha-evidence\\2026-09-27_13-51-27'
const profile = 'C:\\oa-run'
const target = join(evidence, 'smoke-retry-worktree')
const objective = `Phase 5 owned-runtime canary ${Date.now()}. Inspect this workspace strictly read-only. Return absolute root, current HEAD commit, whether Git status is clean, and confirm no file modifications. Do not write files.`
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const { ELECTRON_RUN_AS_NODE: ignored, ...env } = process.env
void ignored
const app = await _electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: {
    ...env,
    NODE_ENV: 'development',
    ORCA_DEV_USER_DATA_PATH: profile,
    ORCA_USER_DATA_PATH: profile,
    ORCA_E2E_HEADFUL: '0'
  },
  timeout: 120000
})
let sessionId = null
let canaryPassed = false
try {
  assert(samePath(await app.evaluate(({ app }) => app.getPath('userData')), profile))
  const page = await app.firstWindow({ timeout: 120000 })
  await page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    { timeout: 90000 }
  )
  await page.evaluate(async () => window.__store.getState().updateSettings({ uiLanguage: 'vi' }))
  const accounts = await page.evaluate(() => window.api.codexAccounts.list())
  const systemDefaultOAuth = accounts.systemDefault?.authKind === 'oauth'
  console.log(
    JSON.stringify({
      accountCount: accounts.accounts.length,
      activeAccount: accounts.activeAccountId !== null,
      systemDefaultAuthKind: accounts.systemDefault?.authKind ?? 'unknown',
      authPath: systemDefaultOAuth ? 'system-default' : 'managed-account'
    })
  )
  assert(
    (accounts.accounts.length > 0 && accounts.activeAccountId !== null) || systemDefaultOAuth,
    'Approved profile has neither an active managed account nor an authenticated system-default account; no automatic sign-in'
  )
  await page.getByRole('button', { name: 'Công việc ORCA', exact: true }).click()
  const surface = page.getByTestId('orca-daily-driver')
  const projects = await page.evaluate(() => window.api.dailyDriver.call({ method: 'projects' }))
  const project = projects.find((row) =>
    row.workspaces.some((workspace) => samePath(workspace.path, target))
  )
  assert(project, 'Approved smoke workspace must already be registered')
  const workspace = project.workspaces.find((row) => samePath(row.path, target))
  for (const [selector, attribute, id] of [
    ['#orca-project', 'data-project-id', project.id],
    ['#orca-workspace', 'data-workspace-id', workspace.id]
  ]) {
    await surface.locator(selector).click()
    const index = await page
      .getByRole('option')
      .evaluateAll(
        (nodes, { attribute, id }) =>
          nodes.findIndex((node) => node.getAttribute(attribute) === id),
        { attribute, id }
      )
    assert(index >= 0, 'Registered UI option must exist')
    await page.getByRole('option').nth(index).click()
  }
  await surface
    .getByLabel('Yêu cầu công việc')
    .fill(objective)
  await surface.getByRole('button', { name: 'Bắt đầu', exact: true }).click()
  console.log('PHASE5_UI_TASK_STARTED_NO_OWNER_VERIFICATION')
  const deadline = Date.now() + 180000
  let view = null,
    last = ''
  while (Date.now() < deadline) {
    const sessions = await page.evaluate(
      (projectId) => window.api.dailyDriver.call({ method: 'sessions', projectId }),
      project.id
    )
    const session = sessions.find((row) =>
      row.objective === objective
    )
    if (session) {
      sessionId = session.logicalWorkSessionId
      view = await page.evaluate(
        (sessionId) => window.api.dailyDriver.call({ method: 'open', sessionId }),
        sessionId
      )
      const item = view.items.find((row) => row.branchId === 'main')
      const status = `${item.status}/${view.runtimeStatus}`
      if (status !== last) {
        last = status
        console.log(JSON.stringify({ sessionId, status }))
      }
      if (['READY_FOR_REVIEW', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(item.status)) {
        break
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert(view, 'No canonical session appeared')
  writeFileSync(join(evidence, 'phase5-owned-ui-view.json'), JSON.stringify(view, null, 2))
  await page.screenshot({ path: join(evidence, 'phase5-owned-ui-result.png'), fullPage: true })
  const item = view.items.find((row) => row.branchId === 'main')
  assert.equal(
    item.status,
    'READY_FOR_REVIEW',
    `Execution did not complete: ${view.runtimeError ?? last}`
  )
  assert.equal(view.runtimeStatus, 'COMPLETED')
  assert(view.result?.trim(), 'Final runtime result must be present')
  console.log(
    JSON.stringify({
      sessionId,
      workItemId: item.workItemId,
      executionId: view.executionId,
      status: item.status,
      resultHash: createHash('sha256').update(view.result).digest('hex')
    })
  )
  // No checkbox, verify request or native-dialog acceptance: runtime success is not owner approval.
  canaryPassed = true
} finally {
  console.log(JSON.stringify({ sessionId, ownerVerification: 'NOT_REQUESTED' }))
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ])
  process.exit(canaryPassed ? 0 : 1)
}
