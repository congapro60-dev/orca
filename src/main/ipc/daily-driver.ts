import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { DailyDriverRequest } from '../../shared/daily-driver-contract'
import type { DailyDriverSessionView } from '../../shared/daily-driver-contract'
import { DailyDriverHost } from '../control-core/daily-driver-host'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

let trustedDailyDriverRendererWebContentsId: number | null = null
export function setTrustedDailyDriverRendererWebContentsId(id: number | null): void {
  trustedDailyDriverRendererWebContentsId = id
}

export function registerDailyDriverHandlers(
  runtime: OrcaRuntimeService,
  resolveCodexHome?: () => string
): void {
  const host = new DailyDriverHost(runtime, resolveCodexHome)
  ipcMain.removeHandler('dailyDriver:call')
  ipcMain.handle('dailyDriver:call', async (event, request: DailyDriverRequest) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    if (
      !ownerWindow ||
      event.senderFrame !== event.sender.mainFrame ||
      event.sender.id !== trustedDailyDriverRendererWebContentsId
    ) {
      throw new Error('Daily Driver requires the current desktop main frame')
    }
    if (request?.method === 'verify') {
      const view = (await host.call({
        method: 'open',
        sessionId: request.sessionId
      })) as DailyDriverSessionView
      const main = view.items.find((item) => item.branchId === 'main')
      if (main?.status !== 'READY_FOR_REVIEW' || !view.result) {
        throw new Error('Review the completed result before verification')
      }
      const decision = await dialog.showMessageBox(ownerWindow, {
        type: 'question',
        buttons: ['Chấp nhận kết quả', 'Quay lại'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: 'Bạn đã xem kết quả và chấp nhận công việc này hoàn thành?',
        detail: `Yêu cầu: ${view.session.objective.slice(0, 500)}\n\nORCA sẽ lưu quyết định cùng bằng chứng thực thi.`
      })
      if (decision.response !== 0) {
        return view
      }
    }
    return host.call(request)
  })
}
