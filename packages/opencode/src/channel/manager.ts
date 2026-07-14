import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { startFeishuChannel, type FeishuChannelConfig } from "./feishu"

export type ChannelConfig =
  | FeishuChannelConfig
  | {
      type: "discord"
      botToken: string
      allowedUsers?: string[]
      proxy?: string
      enabled?: boolean
      model?: string
    }

const log = Log.create({ service: "channel.manager" })

type Handle = { stop: () => void }

let handles: Handle[] = []
let startedFor: string | undefined

export type ChannelManagerStartOptions = {
  baseUrl: string
  /** Project directory used for session.create / prompt (x-opencode-directory). */
  directory?: string
  channels?: Record<string, ChannelConfig>
}

/**
 * Start (or restart) IM channel runtimes for enabled configs.
 * Currently supports Feishu websocket long-connection.
 */
export async function startChannels(opts: ChannelManagerStartOptions): Promise<void> {
  await stopChannels()

  const channels = opts.channels ?? {}
  const directory = opts.directory || process.cwd()
  const baseUrl = opts.baseUrl.replace(/\/$/, "")
  startedFor = baseUrl

  for (const [name, config] of Object.entries(channels)) {
    if (config.enabled === false) continue
    if (config.type === "feishu") {
      if (!config.appId || !config.appSecret) {
        log.warn("feishu channel missing credentials", { name })
        continue
      }
      try {
        const handle = startFeishuChannel({
          name,
          config,
          baseUrl,
          directory,
        })
        handles.push(handle)
      } catch (err) {
        log.error("failed to start feishu channel", { name, error: err })
      }
      continue
    }
    if (config.type === "discord") {
      log.info("discord channel runtime not implemented yet", { name })
    }
  }

  log.info("channel manager started", {
    baseUrl,
    directory,
    count: handles.length,
    stateDir: path.join(Global.Path.state, "channel-sessions.json"),
  })
}

export async function stopChannels(): Promise<void> {
  const prev = handles
  handles = []
  for (const h of prev) {
    try {
      h.stop()
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
