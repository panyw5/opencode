import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { startFeishuChannel, type FeishuChannelConfig } from "./feishu"
import { startQQChannel, type QQChannelConfig } from "./qq"
import { startWechatChannel } from "./wechat"
import type { ConfigChannels } from "@/config/channels"
import { ensureChannelDirectory, resolveChannelDirectory } from "./directory"
import { registry } from "@/im/transport"
import { recoverMessagesWithRetry } from "@/im/dispatcher"
import { IMRetentionMaintenance, type MaintenanceHandle } from "@/im/retention-maintenance"

export type ChannelConfig =
  | FeishuChannelConfig
  | QQChannelConfig
  | ConfigChannels.Wechat
  | {
      type: "discord"
      botToken: string
      allowedUsers?: string[]
      proxy?: string
      enabled?: boolean
      autoReply?: boolean
      model?: string
      /** Working directory for this channel's sessions (decoupled from projects). */
      directory?: string
    }

const log = Log.create({ service: "channel.manager" })

type Handle = {
  stop: () => void | Promise<void>
  channelName: string
  transport: Parameters<typeof registry.register>[0]
}

let handles: Handle[] = []
let startedFor: string | undefined
let maintenance: MaintenanceHandle | undefined
let lifecycle = Promise.resolve()

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(operation, operation)
  lifecycle = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

export type ChannelManagerStartOptions = {
  baseUrl: string
  /**
   * @deprecated Prefer per-channel `config.directory`. Kept as a last-resort
   * fallback when a channel has no directory of its own.
   */
  directory?: string
  channels?: Record<string, ChannelConfig>
}

/**
 * Start (or restart) IM channel runtimes for enabled configs.
 * Supports Feishu, official QQ Gateway, and WeChat iLink connections.
 * Each channel uses its own working directory (not OpenCode projects).
 */
export function startChannels(opts: ChannelManagerStartOptions): Promise<void> {
  return serialized(() => startChannelsInternal(opts))
}

async function startChannelsInternal(opts: ChannelManagerStartOptions): Promise<void> {
  await stopChannelsInternal()

  const channels = opts.channels ?? {}
  const baseUrl = opts.baseUrl.replace(/\/$/, "")
  startedFor = baseUrl

  for (const [name, config] of Object.entries(channels)) {
    if (config.enabled === false) continue
    if (config.type === "wechat") {
      try {
        const directory = resolveChannelDirectory(name, config.directory ?? opts.directory)
        await ensureChannelDirectory(directory)
        const handle = await startWechatChannel({ name, config, baseUrl, directory })
        if (handle) {
          registry.register(handle.transport)
          handles.push({ ...handle, channelName: name })
          log.info("channel transport registered", { name, platform: "wechat" })
        }
      } catch {
        log.error("failed to start wechat channel", { name })
      }
      continue
    }
    if (config.type === "feishu") {
      if (!config.appId || !config.appSecret) {
        log.warn("feishu channel missing credentials", { name })
        continue
      }
      try {
        const directory = resolveChannelDirectory(name, config.directory ?? opts.directory)
        await ensureChannelDirectory(directory)
        const handle = startFeishuChannel({
          name,
          config,
          baseUrl,
          directory,
        })
        registry.register(handle.transport)
        handles.push({ ...handle, channelName: name })
        log.info("channel transport registered", { name, platform: handle.transport.platform })
      } catch (err) {
        log.error("failed to start feishu channel", { name, error: err })
      }
      continue
    }
    if (config.type === "discord") {
      log.info("discord channel runtime not implemented yet", {
        name,
        directory: resolveChannelDirectory(name, config.directory ?? opts.directory),
      })
    }
    if (config.type === "qq") {
      if (!config.appId || !config.clientSecret) {
        log.warn("qq channel missing official bot credentials", { name })
        continue
      }
      try {
        const directory = resolveChannelDirectory(name, config.directory ?? opts.directory)
        await ensureChannelDirectory(directory)
        const handle = startQQChannel({ name, config, baseUrl, directory })
        registry.register(handle.transport)
        handles.push({ ...handle, channelName: name })
        log.info("channel transport registered", { name, platform: handle.transport.platform })
      } catch (err) {
        log.error("failed to start qq channel", { name, error: err })
      }
    }
  }

  log.info("channel manager started", {
    baseUrl,
    count: handles.length,
    hasAuth: !!process.env["OPENCODE_SERVER_PASSWORD"],
    stateDir: path.join(Global.Path.state, "channel-sessions.json"),
  })
  try {
    await recoverMessagesWithRetry()
    const policies = Object.entries(channels)
      .filter(([, config]) => "retentionDays" in config && config.retentionDays !== undefined)
      .map(([channelName, config]) => ({
        channelName,
        retentionDays: (config as unknown as { retentionDays: number }).retentionDays,
      }))
    maintenance = await IMRetentionMaintenance.start(policies)
  } catch (error) {
    log.error("IM startup recovery or retention failed", { error: String(error) })
  }
}

export function stopChannels(): Promise<void> {
  return serialized(stopChannelsInternal)
}

export function refreshWechatChannel(name: string, config: ConfigChannels.Wechat): Promise<void> {
  return serialized(async () => {
    const prior = handles.find((handle) => handle.channelName === name)
    if (prior) {
      registry.unregister(name, prior.transport)
      await prior.stop()
      handles = handles.filter((handle) => handle !== prior)
    }
    if (!startedFor || config.enabled === false) return
    const directory = resolveChannelDirectory(name, config.directory)
    await ensureChannelDirectory(directory)
    const handle = await startWechatChannel({ name, config, baseUrl: startedFor, directory })
    if (handle) {
      registry.register(handle.transport)
      handles.push({ ...handle, channelName: name })
      log.info("wechat authorization runtime refreshed", { name })
    }
  })
}

async function stopChannelsInternal(): Promise<void> {
  const runningMaintenance = maintenance
  maintenance = undefined
  if (runningMaintenance) await runningMaintenance.stop()
  const prev = handles
  handles = []
  for (const h of prev) {
    try {
      registry.unregister(h.channelName, h.transport)
      log.info("channel transport unregistered", { name: h.channelName, platform: h.transport.platform })
      await h.stop()
    } catch (err) {
      log.warn("channel stop error", { error: err })
    }
  }
  if (prev.length) log.info("channel manager stopped", { was: startedFor })
  startedFor = undefined
}

export function isRunning(): boolean {
  return handles.length > 0
}

export * as ChannelManager from "./manager"
