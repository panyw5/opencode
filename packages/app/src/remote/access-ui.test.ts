import { describe, expect, test } from "bun:test"
import QRCode from "qrcode"
import {
  createPairingOperationController,
  connectionElapsed,
  connectionPending,
  deviceActivityAt,
  pairingRemainingSeconds,
  revokeAfterConfirmation,
  shouldClearPairing,
  sortRemoteDevices,
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
  test("formats a host-owned elapsed timer without inventing an ETA or restarting on mount", () => {
    const status: RemoteAccessStatus = {
      enabled: true,
      phase: "connecting",
      stage: "waiting-certificate",
      startedAt: 1_000,
      stageStartedAt: 11_000,
    }
    expect(connectionPending(status)).toBe(true)
    expect(connectionElapsed(status, 124_000)).toBe("02:03")
    expect(connectionElapsed(status, 124_000, true)).toBe("01:53")
    expect(connectionElapsed(status, 125_000)).toBe("02:04")
    expect(connectionElapsed(status, 3_724_000)).toBe("1:02:03")
    expect(connectionElapsed(status, 0)).toBe("00:00")
    expect(connectionElapsed({ enabled: true, phase: "connecting" }, 124_000)).toBeUndefined()
    expect(connectionElapsed({ ...status, phase: "online" }, 124_000)).toBeUndefined()
    expect(connectionPending({ ...status, enabled: false })).toBe(false)
  })
  test("sorts same-named devices by actual recent activity or pairing time without mutating input", () => {
    const older = {
      ...device,
      id: "older",
      createdAt: 1,
      lastSeenAt: 2,
      connection: { state: "active" as const, lastActivityAt: 10, pages: [] },
    }
    const newer = { ...device, id: "newer", createdAt: 5, lastSeenAt: 6 }
    const input = [newer, older]
    expect(deviceActivityAt(older)).toBe(10)
    expect(sortRemoteDevices(input).map((d) => d.id)).toEqual(["older", "newer"])
    expect(sortRemoteDevices(input, "paired").map((d) => d.id)).toEqual(["newer", "older"])
    expect(input[0]).toBe(newer)
  })
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
