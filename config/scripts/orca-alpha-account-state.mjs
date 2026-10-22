import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const port = Number(readFileSync('C:\\oa-run\\DevToolsActivePort', 'utf8').split(/\r?\n/)[0])
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const page = browser.contexts().flatMap((context) => context.pages())
  .find((page) => page.url().includes('index.html'))
if (!page) {
  throw new Error('ORCA app page is unavailable')
}
const state = await page.evaluate(() => window.api.codexAccounts.list())
console.log(JSON.stringify({
  activeAccountId: state.activeAccountId,
  accounts: state.accounts.map((account) => ({ id: account.id, runtime: account.managedHomeRuntime ?? 'host' })),
  systemDefault: { hasAuth: state.systemDefault?.hasAuth, kind: state.systemDefault?.authKind }
}))
await browser.close()
