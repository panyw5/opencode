import { describe, expect, test } from "bun:test"
import QRCode from "qrcode"
import {
  createPairingOperationController,
  pairingRemainingSeconds,
  revokeAfterConfirmation,
  shouldClearPairing,
} from "./access-ui"
import type { RemoteAccessStatus, RemoteDevice } from "./types"

const online: RemoteAccessStatus = { enabled: true, phase: "online", url: "https://relay.invalid" }
const device: RemoteDevice = {
  id: "a".repeat(32),
  name: "Phone",
  createdAt: 1,
  lastSeenAt: 2,
  expiresAt: 3,
}

describe("remote access settings behavior", () => {
  test("generates a real QR matrix locally for the pairing link", () => {
    expect(QRCode.create("https://relay.invalid/remote/connect#one-use-code").modules.size).toBeGreaterThan(0)
  })

  test("counts down pairing links and expires them at zero", () => {
    expect(pairingRemainingSeconds(61_000, 1_000)).toBe(60)
    expect(pairingRemainingSeconds(1_000, 1_001)).toBe(0)
  })

  test("clears pairing busy state when an in-flight operation is invalidated", () => {
    const pairing = createPairingOperationController()
    const operation = pairing.start()
    expect(operation).toBeDefined()
    expect(pairing.busy()).toBe(true)

    pairing.invalidate()
    expect(pairing.busy()).toBe(false)
    expect(pairing.isCurrent(operation!)).toBe(false)
    expect(pairing.finish(operation!)).toBe(false)
    expect(pairing.busy()).toBe(false)
  })

  test("invalidates the pairing when the relay, status, or paired devices change", () => {
    expect(shouldClearPairing({ status: online, devices: [device], previousDevices: [device] })).toBe(false)
    expect(
      shouldClearPairing({
        status: { ...online, url: "https://new-relay.invalid" },
        previousUrl: online.url,
        devices: [device],
        previousDevices: [device],
      }),
    ).toBe(true)
    expect(
      shouldClearPairing({
        status: { ...online, phase: "reconnecting" },
        devices: [device],
        previousDevices: [device],
      }),
    ).toBe(true)
    expect(shouldClearPairing({ status: online, devices: [], previousDevices: [device] })).toBe(true)
  })

  test("requires confirmation before revoking a device", async () => {
    const revoked: string[] = []
    const revoke = async (id: string) => {
      revoked.push(id)
    }

    expect(await revokeAfterConfirmation(device.id, () => false, revoke)).toBe(false)
    expect(revoked).toEqual([])
    expect(await revokeAfterConfirmation(device.id, () => true, revoke)).toBe(true)
    expect(revoked).toEqual([device.id])
  })
})
