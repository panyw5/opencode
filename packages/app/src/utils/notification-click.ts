import { decode64 } from "./base64"

export const QUICK_ASSISTANT_NOTIFICATION_EVENT = "opencode:quick-assistant-notification"
export type AssistantNotificationTarget = { directory: string; session: string }

let nav: ((href: string) => void) | undefined

export const setNavigate = (fn: (href: string) => void) => {
  nav = fn
}

export const handleNotificationClick = (href?: string) => {
  window.focus()
  if (!href) return
  const match = /^\/([^/]+)\/session\/([^/?#]+)$/.exec(href)
  const directory = decode64(match?.[1])
  if (directory && match) {
    const event = new CustomEvent<AssistantNotificationTarget>(QUICK_ASSISTANT_NOTIFICATION_EVENT, {
      detail: { directory, session: match[2] },
      cancelable: true,
    })
    window.dispatchEvent(event)
    console.debug(
      `[notification-click] session=${match[2]} target=${event.defaultPrevented ? "quick-assistant" : "page"}`,
    )
    if (event.defaultPrevented) return
  }
  if (nav) return nav(href)
  console.warn("notification-click: navigate function not set, falling back to window.location.assign")
  window.location.assign(href)
}
