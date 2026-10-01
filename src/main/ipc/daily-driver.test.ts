import { describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>(),
  call: vi.fn(),
  confirmation: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (sender: { id: number }) => (sender.id ? { id: sender.id } : null)
  },
  dialog: { showMessageBox: ipc.confirmation },
  ipcMain: {
    removeHandler: vi.fn((name: string) => ipc.handlers.delete(name)),
    handle: vi.fn((name: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
      ipc.handlers.set(name, handler)
    )
  }
}))
vi.mock('../control-core/daily-driver-host', () => ({
  DailyDriverHost: class {
    call = ipc.call
  }
}))
import {
  registerDailyDriverHandlers,
  setTrustedDailyDriverRendererWebContentsId
} from './daily-driver'

describe('Daily Driver desktop authority', () => {
  it('accepts only the registered main-window main frame and updates after replacement', async () => {
    ipc.call.mockResolvedValue([{ id: 'project-local' }])
    registerDailyDriverHandlers({} as never)
    const handler = ipc.handlers.get('dailyDriver:call')!
    const sender = { id: 19, mainFrame: {} }
    setTrustedDailyDriverRendererWebContentsId(19)
    await expect(
      handler({ sender, senderFrame: sender.mainFrame }, { method: 'projects' })
    ).resolves.toEqual([{ id: 'project-local' }])
    await expect(
      handler({ sender: { id: 20, mainFrame: {} }, senderFrame: {} }, { method: 'projects' })
    ).rejects.toThrow(/main frame/)
    await expect(handler({ sender, senderFrame: {} }, { method: 'projects' })).rejects.toThrow(
      /main frame/
    )
    setTrustedDailyDriverRendererWebContentsId(20)
    await expect(
      handler({ sender, senderFrame: sender.mainFrame }, { method: 'projects' })
    ).rejects.toThrow(/main frame/)
  })

  it('requires native user acceptance before forwarding verification', async () => {
    registerDailyDriverHandlers({} as never)
    const handler = ipc.handlers.get('dailyDriver:call')!
    const sender = { id: 31, mainFrame: {} }
    setTrustedDailyDriverRendererWebContentsId(31)
    const view = {
      session: { objective: 'Inspect' },
      items: [{ branchId: 'main', status: 'READY_FOR_REVIEW' }],
      result: 'Actual result'
    }
    ipc.call.mockClear().mockResolvedValue(view)
    ipc.confirmation.mockResolvedValueOnce({ response: 1 })
    const request = {
      method: 'verify',
      sessionId: 'fixture-session',
      expectedRevision: 1,
      reviewedResultHash: 'a'.repeat(64)
    }
    await expect(handler({ sender, senderFrame: sender.mainFrame }, request)).resolves.toEqual(view)
    expect(ipc.call).toHaveBeenCalledTimes(1)
    expect(ipc.call).toHaveBeenCalledWith({ method: 'open', sessionId: 'fixture-session' })
    ipc.call.mockClear()
    ipc.confirmation.mockResolvedValueOnce({ response: 0 })
    await handler({ sender, senderFrame: sender.mainFrame }, request)
    expect(ipc.call).toHaveBeenCalledWith(request)
  })
})
