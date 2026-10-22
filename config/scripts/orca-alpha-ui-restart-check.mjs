import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'

const require = createRequire(import.meta.url)
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const evidence = 'C:\\Users\\ADMIN\\Documents\\Codex\\orca-alpha-evidence\\2026-09-27_13-51-27'
const expected = JSON.parse(readFileSync(join(evidence, 'phase4-live-ui-result.json'), 'utf8'))
const { ELECTRON_RUN_AS_NODE: ignored, ...env } = process.env
void ignored
const app = await _electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: {
    ...env,
    NODE_ENV: 'development',
    ORCA_DEV_USER_DATA_PATH: 'C:\\oa-run',
    ORCA_USER_DATA_PATH: 'C:\\oa-run',
    ORCA_E2E_HEADFUL: '1'
  },
  timeout: 120_000
})
try {
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
  if (resolve(actualProfile).toLowerCase() !== resolve('C:\\oa-run').toLowerCase()) {
    throw new Error('Unexpected profile after restart')
  }
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    { timeout: 90_000 }
  )
  await page.getByRole('button', { name: 'Công việc ORCA', exact: true }).click()
  const surface = page.getByTestId('orca-daily-driver')
  await surface.getByTestId('orca-task-result').waitFor({ timeout: 30_000 })
  const actual = await surface.getByTestId('orca-task-result').innerText()
  if (actual !== expected.result)
    throw new Error('Stored runtime result differs after whole app restart')
  await page.screenshot({ path: join(evidence, 'phase4-live-restarted.png'), fullPage: true })
  writeFileSync(
    join(evidence, 'phase4-ui-restart-proof.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        profile: actualProfile,
        resultMatched: true,
        runtimeResult: actual,
        visibleLocale: 'vi',
        nativeAcceptance: 'pending'
      },
      null,
      2
    )
  )
  console.log('PHASE4_WHOLE_APP_RESTART_RESULT_AND_VI_PASS')
  if (process.argv.includes('--await-acceptance')) {
    await surface
      .getByRole('checkbox', { name: 'Tôi đã xem và chấp nhận kết quả này đáp ứng yêu cầu.' })
      .check()
    await surface
      .getByRole('button', { name: 'Xác minh kết quả', exact: true })
      .click({ noWaitAfter: true })
    console.log('PHASE4_NATIVE_ACCEPTANCE_DIALOG_OPEN')
    await surface.getByText(/^Đã xác minh ·/).waitFor({ timeout: 0 })
    await page.screenshot({ path: join(evidence, 'phase4-live-verified.png'), fullPage: true })
    console.log('PHASE4_OWNER_ACCEPTED_AND_VERIFIED')
  }
} finally {
  await app.close()
}
