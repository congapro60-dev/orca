import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { DailyDriverRequest } from '../../shared/daily-driver-contract'
import type { DailyDriverSessionView } from '../../shared/daily-driver-contract'
import { DailyDriverHost } from '../control-core/daily-driver-host'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { DailyDriverRequestSchema } from '../control-core/daily-driver-request'
import { selectedTestEvidence } from '../control-core/verification-evidence'

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
    request = DailyDriverRequestSchema.parse(request)
    if (request.method === 'verify') {
      const view = (await host.call({
        method: 'open',
        sessionId: request.sessionId
      })) as DailyDriverSessionView
      const main = view.items.find((item) => item.branchId === 'main')
      if (main?.status !== 'READY_FOR_REVIEW' || !view.result) {
        throw new Error('Review the completed result before verification')
      }
      let tests = ''
      if (view.session.permissionMode === 'WORKSPACE_WRITE') {
        const evidence = view.reviewEvidence
        if (!evidence || evidence.contentHash !== request.reviewedEvidenceHash) {
          throw new Error('Evidence changed or is unavailable; review it again')
        }
        const selected = selectedTestEvidence(evidence, request.testCommandItemIds ?? [])
        tests = `\n\nLệnh bạn xác nhận là kiểm thử (exit 0):\n${selected.map((test) => test.command).join('\n')}\n\nĐây là lệnh runtime đã chạy, không phải kiểm thử độc lập của ORCA.`
      }
      const decision = await dialog.showMessageBox(ownerWindow, {
        type: 'question',
        buttons: ['Chấp nhận kết quả', 'Quay lại'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: 'Bạn đã xem kết quả và chấp nhận công việc này hoàn thành?',
        detail: `Yêu cầu: ${view.session.objective.slice(0, 500)}\n\nORCA sẽ lưu quyết định cùng bằng chứng thực thi.${tests}`
      })
      if (decision.response !== 0) {
        return view
      }
    }
    return host.call(request)
  })
}
