import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron"
import type { RemoteAccessController } from "./controller"
import { isTrustedRemoteRendererUrl } from "./ipc-origin"

export function registerRemoteIpc(controller: RemoteAccessController, getWindow: () => BrowserWindow | null) {
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = getWindow()
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      return false
    return isTrustedRemoteRendererUrl(event.senderFrame.url)
  }
  const handle = (channel: string, action: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) throw new Error("Unauthorized remote access request.")
      return action(...args)
    })
  }
  handle("remote-access-status", () => controller.status())
  handle("remote-access-enable", () => controller.enable())
  handle("remote-access-disable", () => controller.disable())
  handle("remote-access-pair", () => controller.pair())
  handle("remote-access-devices", () => controller.devices())
  handle("remote-access-revoke", (id) => {
    if (typeof id !== "string" || id.length > 64) throw new Error("Invalid device identifier.")
    return controller.revoke(id)
  })
  handle("remote-access-reset", () => controller.reset())
  const unsubscribe = controller.subscribe((status) => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    const frame = window.webContents.mainFrame
    if (frame && isTrustedRemoteRendererUrl(frame.url)) window.webContents.send("remote-access-status-changed", status)
  })
  return unsubscribe
}
