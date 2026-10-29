import type { BrowserWindow, Notification, NotificationConstructorOptions } from "electron"

const MAX_NOTIFICATIONS = 100

export function createSystemNotifications(deps: {
  supported: () => boolean
  create: (options: NotificationConstructorOptions) => Notification
  log: (message: string) => void
}) {
  const active = new Set<Notification>()
  let sequence = 0

  const dispose = (notification: Notification) => {
    active.delete(notification)
    notification.removeAllListeners()
    notification.close()
  }

  return {
    show(window: BrowserWindow, title: unknown, body?: unknown, href?: unknown, attention: unknown = false) {
      if (
        typeof title !== "string" ||
        !title.trim() ||
        title.length > 256 ||
        typeof attention !== "boolean" ||
        (body !== undefined && (typeof body !== "string" || body.length > 4096)) ||
        (href !== undefined &&
          (typeof href !== "string" || !/^\/[A-Za-z0-9_-]+(?:\/session\/[A-Za-z0-9_-]+)?$/.test(href)))
      ) {
        deps.log("rejected invalid notification payload")
        throw new Error("Invalid notification payload")
      }
      const id = ++sequence
      const log = (message: string) => deps.log(`id=${id} window=${window.id} ${message}`)
      log(`requested attention=${attention}`)
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        log("skipped destroyed window")
        return
      }
      if (window.isFocused() && !attention) {
        log("skipped focused window")
        return
      }
      if (!deps.supported()) {
        log("skipped unsupported system")
        return
      }
      let notification: Notification | undefined
      try {
        notification = deps.create({ title, body: body ?? "" })
        const current = notification
        active.add(notification)
        notification.once("show", () => log("native-show-callback presentation=unverified"))
        // Windows emits close when the banner times out, but it can still be
        // clicked in Action Center. Retain a bounded history until click/failure.
        notification.once("close", () => log("banner closed"))
        notification.once("failed", (_event, error) => {
          log(`failed error=${String(error)}`)
          dispose(current)
        })
        notification.once("click", () => {
          log("clicked")
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            if (window.isMinimized()) window.restore()
            window.show()
            window.focus()
            window.webContents.send("notification-click", href)
            log("activated originating window")
          } else {
            log("skipped activation of destroyed window")
          }
          dispose(current)
        })
        while (active.size > MAX_NOTIFICATIONS) {
          const oldest = active.values().next().value
          if (oldest) dispose(oldest)
        }
        notification.show()
        log("submitted")
      } catch (error) {
        if (notification) dispose(notification)
        // Native failures must not become unhandled renderer rejections.
        log(`failed error=${String(error)}`)
      }
    },
    dispose() {
      for (const notification of active) dispose(notification)
      deps.log("disposed notifications")
    },
  }
}
