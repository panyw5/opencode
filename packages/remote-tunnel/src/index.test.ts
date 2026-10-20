import { expect, mock, test } from "bun:test"
import type { TunnelIdentity, PendingTunnelIdentity, TunnelStoreSnapshot, TunnelSetupStage } from "./index"

type SdkIdentity = Omit<TunnelIdentity, "certificateExpiry"> & { certificateExpiry: Date }
type Storage = {
  load(profile: string): Promise<SdkIdentity | undefined>
  save(profile: string, value: SdkIdentity): Promise<void>
  savePending(profile: string, value: PendingTunnelIdentity): Promise<void>
}
let storage: Storage
let exercise: () => Promise<void> = async () => {}
const profile = "opencode-desktop-remote"
const pending: PendingTunnelIdentity = {
  id: "test",
  hostname: "relay.invalid",
  token: "test-token",
  privateKey: "test-key",
  csr: "test-csr",
}
const identity: TunnelIdentity = {
  ...pending,
  certificate: "test-cert",
  chain: "test-chain",
  certificateExpiry: "2030-01-01T00:00:00.000Z",
}
const connection = {
  tunnel: { hostname: "relay.invalid" },
  events: (async function* () {})(),
  closed: new Promise<void>(() => {}),
  close: async () => {},
}

mock.module("@opentunnel/client", () => ({
  create: (options: { store: Storage }) => {
    storage = options.store
    return {
      tunnel: {
        connect: async () => {
          await exercise()
          return connection
        },
        pending: async () => undefined,
        resume: async () => undefined,
        remove: async () => {},
      },
      dispose: async () => {},
    }
  },
}))
const { createRemoteTunnelTransport } = await import("./index")

test("first-time setup reports persisted identity transitions without changing SDK connect semantics", async () => {
  let snapshot: TunnelStoreSnapshot = { version: 1, identities: {}, pending: {} }
  const stages: TunnelSetupStage[] = []
  exercise = async () => {
    await storage.savePending(profile, pending)
    await storage.savePending(profile, pending)
    await storage.save(profile, { ...identity, certificateExpiry: new Date(identity.certificateExpiry) })
  }
  const transport = await createRemoteTunnelTransport(
    {
      load: async () => snapshot,
      save: async (value) => {
        snapshot = value
      },
    },
    { onProgress: (stage) => stages.push(stage) },
  )
  expect(await transport.connect("127.0.0.1:1234", new AbortController().signal)).toBe(connection)
  expect(stages).toEqual(["registering", "waiting-certificate", "connecting-relay"])
  expect(snapshot.pending).toEqual({})
  expect(snapshot.identities[profile].certificateExpiry).toBe(identity.certificateExpiry)
  await storage.save(profile, { ...identity, certificateExpiry: new Date(identity.certificateExpiry) })
  expect(stages).toHaveLength(3)
  await transport.dispose()
})

test("cached identities skip registration and a pending identity resumes the certificate hint", async () => {
  for (const existing of [true, false]) {
    const stages: TunnelSetupStage[] = []
    exercise = async () => {}
    const snapshot: TunnelStoreSnapshot = {
      version: 1,
      identities: existing ? { [profile]: identity } : {},
      pending: existing ? {} : { [profile]: pending },
    }
    const transport = await createRemoteTunnelTransport(
      { load: async () => snapshot, save: async () => {} },
      { onProgress: (stage) => stages.push(stage) },
    )
    await transport.connect("127.0.0.1:1234", new AbortController().signal)
    expect(stages).toEqual([existing ? "connecting-relay" : "waiting-certificate"])
    await transport.dispose()
  }
})
