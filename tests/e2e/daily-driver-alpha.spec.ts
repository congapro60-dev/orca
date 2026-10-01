import { test, expect } from './helpers/orca-app'

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
  await expect(page.getByRole('button', { name: 'Inspect the test project read-only' })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('orca-daily-vi.png'), fullPage: true })

  await orcaPage.reload()
  await orcaPage.getByRole('button', { name: 'Công việc ORCA' }).click()
  await expect(
    orcaPage.getByTestId('orca-daily-driver').getByRole('heading', { name: 'Công việc ORCA' })
  ).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Inspect the test project read-only' }).click()
  await expect(orcaPage.getByTestId('orca-daily-driver').getByRole('heading', { name: 'Inspect the test project read-only' })).toBeVisible()
})
