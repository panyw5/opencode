import { app, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import type { SshServersState } from "../../preload/types"
import type { SshServersController } from "./servers"

export function registerSshIpcHandlers(controller: SshServersController) {
  const subscriptions = new Map<number, () => void>()
  const unsubscribe = (id: number) => {
    const off = subscriptions.get(id)
    if (!off) return
    off()
    subscriptions.delete(id)
  }

  app.once("will-quit", () => {
    subscriptions.forEach((off) => off())
    subscriptions.clear()
  })

  ipcMain.handle("ssh-servers-subscribe", (event) => {
    const id = event.sender.id
    if (subscriptions.has(id)) return
    subscriptions.set(
      id,
      controller.subscribe((payload) => {
        if (event.sender.isDestroyed()) {
          unsubscribe(id)
          return
        }
        event.sender.send("ssh-servers-event", payload)
      }),
    )
    event.sender.once("destroyed", () => unsubscribe(id))
  })
  ipcMain.handle("ssh-servers-unsubscribe", (event) => unsubscribe(event.sender.id))
  ipcMain.handle("ssh-servers-get-state", () => controller.getState())
  ipcMain.handle("ssh-servers-probe-host", (_event: IpcMainInvokeEvent, target: string) =>
    controller.probeHost(requireSshIpcString("target", target)),
  )
  ipcMain.handle("ssh-servers-probe-opencode", (_event: IpcMainInvokeEvent, target: string) =>
    controller.probeOpencode(requireSshIpcString("target", target)),
  )
  ipcMain.handle("ssh-servers-install-opencode", (_event: IpcMainInvokeEvent, target: string) =>
    controller.installOpencode(requireSshIpcString("target", target)),
  )
  ipcMain.handle("ssh-servers-add", (_event: IpcMainInvokeEvent, target: string, autoStart: boolean | undefined) =>
    controller.addServer(requireSshIpcString("target", target), autoStart ?? true),
  )
  ipcMain.handle("ssh-servers-remove", (_event: IpcMainInvokeEvent, id: string) =>
    controller.removeServer(requireSshIpcString("server id", id)),
  )
  ipcMain.handle("ssh-servers-start", (_event: IpcMainInvokeEvent, id: string) =>
    controller.startServer(requireSshIpcString("server id", id)),
  )
  ipcMain.handle("ssh-servers-list-directory", (_event: IpcMainInvokeEvent, target: string, path: string) =>
    controller.listRemoteDirectory(requireSshIpcString("target", target), requireSshIpcString("path", path)),
  )
  ipcMain.handle("ssh-servers-validate-directory", (_event: IpcMainInvokeEvent, target: string, path: string) =>
    controller.validateRemoteDirectory(requireSshIpcString("target", target), requireSshIpcString("path", path)),
  )
}

function requireSshIpcString(name: string, value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing SSH IPC string: ${name}`)
  }
  return value
}
