import { test, expect } from './helpers/orca-app'
import type { DailyDriverSessionView } from '../../src/shared/daily-driver-contract'

test('ORCA Daily Driver shows a registered local project and persists Vietnamese across reload', async ({
  orcaPage
}, testInfo) => {
  await orcaPage.getByRole('button', { name: /^(ORCA Work|Công việc ORCA)$/ }).click()
  const page = orcaPage.getByTestId('orca-daily-driver')
  await expect(page).toBeVisible()
  await expect(page.locator('#orca-project')).toBeVisible()
  await expect(page.locator('#orca-workspace')).toBeVisible()
  await expect(page.locator('#orca-objective')).toBeVisible()

  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ uiLanguage: 'vi' })
  })
  await expect(page.getByRole('heading', { name: 'Công việc ORCA' })).toBeVisible()
  await expect(page.getByText('Chỉ đọc — Codex không được sửa tệp').first()).toBeVisible()
  await page.getByLabel('Yêu cầu công việc').fill('Inspect the test project read-only')
  await page.getByRole('button', { name: 'Bắt đầu' }).click()
  await expect(
    page.getByRole('button', { name: 'Inspect the test project read-only' })
  ).toBeVisible()
  // No account/model call: Windows owned cleanup can prove a failed preflight is safe to retry.
  const recoveryText =
    process.platform === 'win32' ? 'Đủ điều kiện xét tiếp tục' : 'Chưa đủ bằng chứng để chạy lại'
  await expect(page.getByRole('button', { name: 'Kiểm tra trạng thái khôi phục' })).toBeVisible({
    timeout: 30000
  })
  const before = (await orcaPage.evaluate(async () => {
    const sessionId = localStorage.getItem('orca.dailyDriver.session')!
    return window.api.dailyDriver.call({ method: 'open', sessionId })
  })) as DailyDriverSessionView
  await page.getByRole('button', { name: 'Kiểm tra trạng thái khôi phục' }).click()
  await expect(page.getByRole('status')).toContainText(recoveryText)
  await expect(page.getByRole('status')).toContainText('Kiểm tra này không chạy công việc')
  await expect(page.getByRole('button', { name: 'Chạy lại công việc' })).toHaveCount(
    process.platform === 'win32' ? 1 : 0
  )
  const reconciled = (await orcaPage.evaluate(
    async (sessionId) => window.api.dailyDriver.call({ method: 'open', sessionId }),
    before.session.logicalWorkSessionId
  )) as DailyDriverSessionView
  expect(reconciled.executionId).toBe(before.executionId)
  expect(reconciled.items.find((item) => item.branchId === 'main')?.status).toBe('FAILED')
  await orcaPage.screenshot({ path: testInfo.outputPath('orca-daily-vi.png'), fullPage: true })

  await orcaPage.reload()
  await orcaPage.getByRole('button', { name: 'Công việc ORCA' }).click()
  await expect(
    orcaPage.getByTestId('orca-daily-driver').getByRole('heading', { name: 'Công việc ORCA' })
  ).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Inspect the test project read-only' }).click()
  await expect(
    orcaPage
      .getByTestId('orca-daily-driver')
      .getByRole('heading', { name: 'Inspect the test project read-only' })
  ).toBeVisible()
  await expect(orcaPage.getByTestId('orca-daily-driver').getByRole('status')).toContainText(
    recoveryText
  )
})
