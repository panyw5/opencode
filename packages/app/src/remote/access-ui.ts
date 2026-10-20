import type { RemoteAccessStatus, RemoteDevice } from "./types"

export function connectionPending(status: RemoteAccessStatus) {
  return status.enabled && ["starting", "connecting", "reconnecting"].includes(status.phase)
}

export function connectionElapsed(status: RemoteAccessStatus, now: number, stage = false) {
  const started = stage ? status.stageStartedAt : status.startedAt
  if (!connectionPending(status) || typeof started !== "number" || !Number.isFinite(started)) return undefined
  const seconds = Math.max(0, Math.floor((now - started) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  const rest = String(seconds % 60).padStart(2, "0")
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${String(minutes).padStart(2, "0")}:${rest}`
}

export function deviceActivityAt(device: RemoteDevice) {
  return Math.max(device.lastSeenAt, device.connection?.lastActivityAt ?? 0)
}

export function sortRemoteDevices(devices: RemoteDevice[], order: "activity" | "paired" = "activity") {
  return [...devices].sort(
    (a, b) =>
      (order === "activity" ? deviceActivityAt(b) - deviceActivityAt(a) : b.createdAt - a.createdAt) ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  )
}

export function createPairingOperationController() {
  let generation = 0
  let busy = false

  return {
    start() {
      if (busy) return undefined
      busy = true
      return ++generation
    },
    isCurrent(token: number) {
      return token === generation
    },
    invalidate() {
      generation++
      busy = false
    },
    finish(token: number) {
      if (token !== generation) return false
      busy = false
      return true
    },
    busy() {
      return busy
    },
  }
}

export function pairingRemainingSeconds(expiresAt: number, now = Date.now()) {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

export function shouldClearPairing(input: {
  status: RemoteAccessStatus
  previousUrl?: string
  devices: RemoteDevice[]
  previousDevices: RemoteDevice[]
}) {
  if (!input.status.enabled || input.status.phase !== "online") return true
  if (input.previousUrl && input.status.url !== input.previousUrl) return true
  const ids = new Set(input.previousDevices.map((device) => device.id))
  return input.devices.length !== ids.size || input.devices.some((device) => !ids.has(device.id))
}

export async function revokeAfterConfirmation(
  id: string,
  confirm: () => boolean,
  revoke: (id: string) => Promise<void>,
) {
  if (!confirm()) return false
  await revoke(id)
  return true
}
