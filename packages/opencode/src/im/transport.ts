import { Capabilities, type IMTransport, type Platform } from "./model"

export class SendValidationError extends Error {}

/** Provider explicitly rejected a request; unlike a timeout, acceptance is known not to have happened. */
export class ProviderRejectedError extends Error {
  constructor(
    readonly platform: Platform,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(`${platform} rejected IM send${status ? ` (HTTP ${status})` : ""}${code ? ` (code ${code})` : ""}`)
  }
}

/** Process-local registry owned by ChannelManager. It never stores credentials. */
class Registry {
  private readonly items = new Map<string, IMTransport>()

  register(transport: IMTransport) {
    this.items.set(transport.channelName, transport)
  }

  unregister(channelName: string, expected?: IMTransport) {
    if (!expected || this.items.get(channelName) === expected) this.items.delete(channelName)
  }

  get(channelName: string): IMTransport | undefined {
    return this.items.get(channelName)
  }

  list(): IMTransport[] {
    return [...this.items.values()]
  }
}

export const registry = new Registry()

export function transportCapabilities(platform: Platform): Capabilities {
  if (platform === "feishu") {
    return new Capabilities({
      passiveReply: true,
      proactiveC2C: "supported",
      proactiveGroup: "supported",
      proactiveGuild: "supported",
    })
  }
  return new Capabilities({
    passiveReply: true,
    // QQ permits these API shapes, but platform quotas and eligibility are
    // account-dependent. Keep the limitation explicit to callers.
    proactiveC2C: "limited",
    proactiveGroup: "limited",
    proactiveGuild: "unsupported",
  })
}

export * as IMTransport from "./transport"
