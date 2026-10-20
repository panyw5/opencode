export type TunnelIdentity = {
  id: string
  hostname: string
  token: string
  privateKey: string
  certificate: string
  chain: string
  certificateExpiry: string
}
type SdkTunnelIdentity = Omit<TunnelIdentity, "certificateExpiry"> & { certificateExpiry: Date }

export type PendingTunnelIdentity = {
  id: string
  hostname: string
  token: string
  privateKey: string
  csr: string
}

export type TunnelStoreSnapshot = {
  version: 1
  identities: Record<string, TunnelIdentity>
  pending: Record<string, PendingTunnelIdentity>
}

export type TunnelStore = {
  load(): Promise<TunnelStoreSnapshot>
  save(snapshot: TunnelStoreSnapshot): Promise<void>
}

export type OpenTunnelConnection = {
  tunnel: { hostname: string }
  events: AsyncIterable<{ _tag?: string; type?: string }>
  closed: Promise<void>
  close(): Promise<void>
}

export type RemoteTunnelTransport = {
  connect(target: string, signal: AbortSignal): Promise<OpenTunnelConnection>
  remove(): Promise<void>
  dispose(): Promise<void>
}

export type TunnelSetupStage = "registering" | "waiting-certificate" | "connecting-relay"

type TunnelClient = {
  tunnel: {
    connect(input: {
      profile?: string
      routes: Record<string, string>
      signal?: AbortSignal
    }): Promise<OpenTunnelConnection>
    remove(options?: { profile?: string }): Promise<void>
    pending(options?: { profile?: string }): Promise<{ id: string; hostname: string } | undefined>
    resume(options?: { profile?: string }): Promise<unknown>
  }
  dispose(): Promise<void>
}

const PROFILE = "opencode-desktop-remote"

/** Create an SDK client with app-owned storage, never the global OpenTunnel CLI profile. */
export async function createRemoteTunnelTransport(
  store: TunnelStore,
  options: { onProgress?: (stage: TunnelSetupStage) => void } = {},
): Promise<RemoteTunnelTransport> {
  const sdk = await import("@opentunnel/client")
  const snapshot = await store.load()
  const identities = new Map(Object.entries(snapshot.identities))
  const pending = new Map(Object.entries(snapshot.pending))
  let writes = Promise.resolve()
  let connecting = false
  let previousStage: TunnelSetupStage | undefined
  const progress = (stage: TunnelSetupStage) => {
    if (!connecting || previousStage === stage) return
    previousStage = stage
    options.onProgress?.(stage)
  }
  const persist = () => {
    const next: TunnelStoreSnapshot = {
      version: 1,
      identities: Object.fromEntries(identities),
      pending: Object.fromEntries(pending),
    }
    writes = writes.then(() => store.save(next))
    return writes
  }
  const storage = {
    profiles: async () => [...new Set([...identities.keys(), ...pending.keys()])].sort(),
    load: async (profile: string): Promise<SdkTunnelIdentity | undefined> => {
      const identity = identities.get(profile)
      return identity && { ...identity, certificateExpiry: new Date(identity.certificateExpiry) }
    },
    save: async (profile: string, identity: SdkTunnelIdentity) => {
      identities.set(profile, {
        ...identity,
        certificateExpiry:
          identity.certificateExpiry instanceof Date
            ? identity.certificateExpiry.toISOString()
            : String(identity.certificateExpiry),
      })
      pending.delete(profile)
      await persist()
      progress("connecting-relay")
    },
    loadPending: async (profile: string) => pending.get(profile),
    savePending: async (profile: string, identity: PendingTunnelIdentity) => {
      pending.set(profile, identity)
      await persist()
      progress("waiting-certificate")
    },
    remove: async (profile: string) => {
      identities.delete(profile)
      pending.delete(profile)
      await persist()
    },
    list: async () =>
      [...identities].map(([profile, tunnel]) => ({
        profile,
        tunnel: { ...tunnel, certificateExpiry: new Date(tunnel.certificateExpiry) } satisfies SdkTunnelIdentity,
      })),
  }
  const client = sdk.create({ store: storage }) as TunnelClient
  const remove = async () => {
    if (await client.tunnel.pending({ profile: PROFILE })) await client.tunnel.resume({ profile: PROFILE })
    await client.tunnel.remove({ profile: PROFILE })
  }
  return {
    connect: async (target, signal) => {
      connecting = true
      previousStage = undefined
      try {
        progress(
          identities.has(PROFILE) ? "connecting-relay" : pending.has(PROFILE) ? "waiting-certificate" : "registering",
        )
        return await client.tunnel.connect({ profile: PROFILE, routes: { "@": target }, signal })
      } finally {
        connecting = false
      }
    },
    remove,
    dispose: () => client.dispose(),
  }
}
