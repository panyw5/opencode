import type { RemoteAccessStatus, RemoteDevice } from "./types"

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
