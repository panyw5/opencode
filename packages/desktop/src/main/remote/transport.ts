import { createRemoteTunnelTransport } from "@opencode-ai/remote-tunnel"
import type { TunnelStore } from "@opencode-ai/remote-tunnel"

export type { OpenTunnelConnection, RemoteTunnelTransport, TunnelStoreSnapshot } from "@opencode-ai/remote-tunnel"
export type { TunnelStore } from "@opencode-ai/remote-tunnel"

export const createOpenTunnelTransport = createRemoteTunnelTransport
export type OpenTunnelStore = TunnelStore
