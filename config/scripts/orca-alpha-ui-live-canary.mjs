import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

const require = createRequire(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const evidenceRoot = 'C:\\Users\\ADMIN\\Documents\\Codex\\orca-alpha-evidence\\2026-09-27_13-51-27'
const userData = 'C:\\oa-run'
const targetPath = join(evidenceRoot, 'smoke-retry-worktree')
const comparePath = (value) => resolve(value).toLowerCase().replaceAll('\\', '/')
const { ELECTRON_RUN_AS_NODE: ignored, ...env } = process.env
void ignored

const app = await _electron.launch({
  executablePath: require('electron'),
  args: [repoRoot],
  env: {
    ...env,
    NODE_ENV: 'development',
    ORCA_DEV_USER_DATA_PATH: userData,
    ORCA_USER_DATA_PATH: userData,
    ORCA_E2E_HEADFUL: '1'
  },
  timeout: 120_000
})
let complete = false
try {
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
  if (comparePath(actualProfile) !== comparePath(userData))
    throw new Error('Unexpected Orca profile')
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    { timeout: 90_000 }
  )
  await page.evaluate(async () => window.__store.getState().updateSettings({ uiLanguage: 'vi' }))
  await page.getByRole('button', { name: 'Công việc ORCA', exact: true }).click()
  const surface = page.getByTestId('orca-daily-driver')
  await surface.waitFor({ state: 'visible' })
  const accountState = await page.evaluate(() => window.api.codexAccounts.list())
  console.log(
    JSON.stringify({
      activeAccountId: accountState.activeAccountId,
      accountCount: accountState.accounts.length,
      systemAuthKind: accountState.systemDefault?.authKind ?? 'unknown'
    })
  )
  if (process.argv.includes('--connect')) {
    await surface.getByRole('button', { name: 'Đăng nhập Codex', exact: true }).click()
    console.log('PHASE4_SUPPORTED_CODEX_SIGNIN_STARTED')
    await page.waitForFunction(
      async () => {
        const state = await window.api.codexAccounts.list()
        return state.accounts.length > 0 && state.activeAccountId !== null
      },
      null,
      { timeout: 300_000 }
    )
    console.log('PHASE4_CODEX_ACCOUNT_CONNECTED')
  }
  const projects = await page.evaluate(() => window.api.dailyDriver.call({ method: 'projects' }))
  const project = projects.find((row) =>
    row.workspaces.some((workspace) => comparePath(workspace.path) === comparePath(targetPath))
  )
  if (!project) throw new Error('Approved smoke retry workspace is not registered')
  const workspace = project.workspaces.find(
    (row) => comparePath(row.path) === comparePath(targetPath)
  )
  await surface.locator('#orca-project').click()
  const projectIndex = await page
    .getByRole('option')
    .evaluateAll(
      (nodes, id) => nodes.findIndex((node) => node.getAttribute('data-project-id') === id),
      project.id
    )
  if (projectIndex < 0) throw new Error('Approved project option is missing')
  await page.getByRole('option').nth(projectIndex).click()
  await surface.locator('#orca-workspace').click()
  const workspaceIndex = await page
    .getByRole('option')
    .evaluateAll(
      (nodes, id) => nodes.findIndex((node) => node.getAttribute('data-workspace-id') === id),
      workspace.id
    )
  if (workspaceIndex < 0) throw new Error('Approved workspace option is missing')
  await page.getByRole('option').nth(workspaceIndex).click()
  const objective =
    'Inspect this repository strictly read-only. Return its absolute root, current HEAD commit, whether Git status is clean, and confirm that you made no modifications. Do not write files.'
  await surface.getByLabel('Yêu cầu công việc').fill(objective)
  await surface.getByRole('button', { name: 'Bắt đầu', exact: true }).click()
  console.log('PHASE4_UI_TASK_STARTED')
  await surface
    .getByText('Codex đã trả kết quả. Xem bằng chứng rồi xác minh.', { exact: true })
    .waitFor({ timeout: 180_000 })
  const result = await surface.getByTestId('orca-task-result').innerText()
  const record = {
    timestamp: new Date().toISOString(),
    profile: actualProfile,
    projectId: project.id,
    workspaceId: workspace.id,
    worktree: workspace.path,
    objective,
    result
  }
  writeFileSync(join(evidenceRoot, 'phase4-live-ui-result.json'), JSON.stringify(record, null, 2))
  await page.screenshot({ path: join(evidenceRoot, 'phase4-live-result.png'), fullPage: true })
  console.log('PHASE4_RESULT_READY_FOR_OWNER_REVIEW')
  console.log(JSON.stringify({ result, worktree: workspace.path }))
  await surface
    .getByRole('checkbox', { name: 'Tôi đã xem và chấp nhận kết quả này đáp ứng yêu cầu.' })
    .check()
  await surface
    .getByRole('button', { name: 'Xác minh kết quả', exact: true })
    .click({ noWaitAfter: true })
  console.log('PHASE4_NATIVE_ACCEPTANCE_DIALOG_OPEN')
  await surface.getByText(/^Đã xác minh ·/).waitFor({ timeout: 300_000 })
  await page.screenshot({ path: join(evidenceRoot, 'phase4-live-verified.png'), fullPage: true })
  console.log('PHASE4_VERIFIED_IN_UI')
  complete = true
} finally {
  if (!complete) console.log('PHASE4_LIVE_CANARY_NOT_CERTIFIED')
  await app.close()
}
