import type { RemoteDevice, RemotePage } from "@opencode-ai/app/remote/types"

export const PRESENCE_TTL_MS = 60_000
const PAGE_KINDS = new Set([
  "home",
  "session",
  "project-tasks",
  "scheduled-tasks",
  "settings",
  "config",
  "workspace",
  "other",
])
type PageVisit = RemotePage & { visible: boolean; updatedAt: number; sequence: number; closed: boolean }

// Presence is a bounded, in-memory browser lease, never an authorization record.
export class RemotePresence {
  private readonly devices = new Map<string, { lastActivityAt: number; tabs: Map<string, PageVisit> }>()

  constructor(private readonly now = () => Date.now()) {}

  update(deviceID: string, input: unknown): boolean {
    if (!input || typeof input !== "object") return false
    const value = input as Record<string, unknown>
    if (typeof value.clientID !== "string" || !/^[a-zA-Z0-9-]{16,64}$/.test(value.clientID)) return false
    if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return false
    const now = this.now()
    let device = this.devices.get(deviceID)
    if (device) this.prune(device.tabs, now)
    const previous = device?.tabs.get(value.clientID)
    if (previous && value.sequence <= previous.sequence) return true
    if (value.closed === true) {
      if (!device) this.devices.set(deviceID, (device = { lastActivityAt: now, tabs: new Map() }))
      if (!previous && device.tabs.size >= 8) return false
      device.lastActivityAt = now
      device.tabs.set(value.clientID, {
        kind: "other",
        visible: false,
        closed: true,
        sequence: value.sequence,
        updatedAt: now,
      })
      return true
    }
    if (typeof value.visible !== "boolean" || !value.page || typeof value.page !== "object") return false
    const page = value.page as Record<string, unknown>
    if (typeof page.kind !== "string" || !PAGE_KINDS.has(page.kind)) return false
    if (
      page.project !== undefined &&
      (typeof page.project !== "string" || page.project.length > 80 || /[\x00-\x1f\x7f]/.test(page.project))
    )
      return false
    if (
      page.sessionID !== undefined &&
      (typeof page.sessionID !== "string" || !/^ses_[a-zA-Z0-9_-]{1,128}$/.test(page.sessionID))
    )
      return false
    if (!device) this.devices.set(deviceID, (device = { lastActivityAt: now, tabs: new Map() }))
    if (!device.tabs.has(value.clientID) && device.tabs.size >= 8) return false
    device.lastActivityAt = now
    device.tabs.set(value.clientID, {
      kind: page.kind as RemotePage["kind"],
      ...(typeof page.project === "string" ? { project: page.project } : {}),
      ...(typeof page.sessionID === "string" ? { sessionID: page.sessionID } : {}),
      visible: value.visible,
      updatedAt: now,
      sequence: value.sequence,
      closed: false,
    })
    return true
  }

  connection(deviceID: string): NonNullable<RemoteDevice["connection"]> {
    const device = this.devices.get(deviceID)
    if (!device) return { state: "unknown", pages: [] }
    this.prune(device.tabs, this.now())
    const pages = [...device.tabs.values()]
      .filter((page) => !page.closed)
      .sort((a, b) => Number(b.visible) - Number(a.visible) || b.updatedAt - a.updatedAt)
    return {
      state: pages.some((page) => page.visible) ? "active" : pages.length > 0 ? "background" : "offline",
      lastActivityAt: device.lastActivityAt,
      pages: pages.map(({ sequence: _sequence, closed: _closed, ...page }) => ({ ...page })),
    }
  }

  remove(deviceID: string) {
    this.devices.delete(deviceID)
  }
  retain(deviceIDs: string[]) {
    const valid = new Set(deviceIDs)
    for (const id of this.devices.keys()) if (!valid.has(id)) this.devices.delete(id)
  }
  clear() {
    this.devices.clear()
  }

  private prune(tabs: Map<string, PageVisit>, now: number) {
    for (const [id, page] of tabs) if (now - page.updatedAt >= PRESENCE_TTL_MS) tabs.delete(id)
  }
}
