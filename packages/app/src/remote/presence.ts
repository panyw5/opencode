import { decode64 } from "../utils/base64"
import type { RemotePage } from "./types"
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function remotePageForPath(pathname: string): RemotePage {
  const path = pathname.split(/[?#]/, 1)[0]
  if (path === "/") return { kind: "home" }
  if (path === "/config") return { kind: "config" }
  if (path === "/scheduled") return { kind: "scheduled-tasks" }
  const [, slug, route, sessionID] = path.split("/")
  const directory = decode64(slug)
  const project = directory
    ?.replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, 80)
  const kind =
    route === "session"
      ? "session"
      : route === "config"
        ? "config"
        : route === "scheduled"
          ? "scheduled-tasks"
          : route === undefined
            ? "workspace"
            : "other"
  return {
    kind,
    ...(project ? { project } : {}),
    ...(kind === "session" && /^ses_[a-zA-Z0-9_-]{1,128}$/.test(sessionID ?? "") ? { sessionID } : {}),
  }
}

export function createRemotePresenceReporter(options: {
  fetcher: FetchLike
  readPage(): RemotePage
  visible(): boolean
  now?: () => number
  clientID?: string
}) {
  const clientID = options.clientID ?? crypto.randomUUID()
  const now = options.now ?? Date.now
  let previous = ""
  let lastSent = -Infinity
  let stopped = false
  let pending = false
  let failed = false
  let sequence = 0
  let completed = 0

  const send = async (closed = false) => {
    if (stopped || (pending && !closed)) return
    const payload = {
      clientID,
      page: options.readPage(),
      visible: options.visible(),
      ...(closed ? { closed: true } : {}),
    }
    const key = JSON.stringify(payload)
    if (!closed && previous === key && now() - lastSent < 20_000) return
    const current = ++sequence
    const body = JSON.stringify({ ...payload, sequence: current })
    pending = true
    try {
      const response = await options.fetcher("/remote/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`status=${response.status}`)
      if (current < completed) return
      completed = current
      previous = key
      lastSent = now()
      if (failed || closed) console.debug(`[remote-presence] ${closed ? "page-closed" : "connection-restored"}`)
      failed = false
    } catch {
      if (!failed && !stopped) console.debug("[remote-presence] heartbeat-failed; will retry")
      failed = true
    } finally {
      pending = false
    }
  }

  return {
    update: () => send(),
    close: () => send(true),
    dispose: () => {
      stopped = true
    },
  }
}

export function installRemotePresence(fetcher: FetchLike) {
  const readPage = (): RemotePage => {
    const page = remotePageForPath(location.pathname)
    if (document.querySelector('[data-component="dialog"] .settings-dialog')) return { kind: "settings" }
    for (const [name, kind] of [
      ["project-tasks", "project-tasks"],
      ["scheduled-tasks", "scheduled-tasks"],
    ] as const) {
      for (const panel of document.querySelectorAll(`[data-component="sidebar-panel"][data-panel="${name}"]`)) {
        const rect = panel.getBoundingClientRect()
        if (rect.width > 0 && rect.right > 0 && rect.left < innerWidth) return { ...page, kind, sessionID: undefined }
      }
    }
    return page
  }
  const reporter = createRemotePresenceReporter({
    fetcher,
    readPage,
    visible: () => document.visibilityState === "visible",
  })
  const update = () => {
    void reporter.update()
  }
  const close = () => {
    void reporter.close()
  }
  // Poll only page metadata, not message contents; send unchanged heartbeats every 20s.
  const timer = setInterval(update, 5_000)
  document.addEventListener("visibilitychange", update)
  window.addEventListener("pagehide", close)
  window.addEventListener("pageshow", update)
  window.addEventListener("popstate", update)
  update()
  console.debug("[remote-presence] tracking-started")
  return () => {
    clearInterval(timer)
    document.removeEventListener("visibilitychange", update)
    window.removeEventListener("pagehide", close)
    window.removeEventListener("pageshow", update)
    window.removeEventListener("popstate", update)
    close()
    reporter.dispose()
  }
}
