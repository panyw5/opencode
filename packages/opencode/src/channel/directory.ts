import path from "path"
import fs from "fs/promises"
import os from "os"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"

const log = Log.create({ service: "channel.directory" })

/** Sanitize channel name for use as a folder segment. */
export function sanitizeChannelName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || "channel"
}

/**
 * Expand `~` / `~/…` against home. Absolute paths are returned normalized.
 */
export function expandHomePath(input: string, home = os.homedir()): string {
  const raw = input.trim()
  if (!raw) return raw
  if (raw === "~") return home
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.resolve(home, raw.slice(2))
  }
  return path.resolve(raw)
}

/**
 * Default work folder for an IM channel — same family as quick-assistant
 * (`{config}/quick-assistant`), under OpenCode config:
 * `{Global.Path.config}/channels/{channelName}`
 * e.g. `~/.config/opencode/channels/work-feishu`
 */
export function defaultChannelDirectory(
  channelName: string,
  configDir = Global.Path.config,
): string {
  return path.join(configDir, "channels", sanitizeChannelName(channelName))
}

/**
 * Resolve the working directory for a channel config entry.
 * Prefer explicit `directory`; otherwise `{configDir}/channels/{name}`.
 */
export function resolveChannelDirectory(
  channelName: string,
  directory: string | undefined | null,
  configDir = Global.Path.config,
  home = os.homedir(),
): string {
  const explicit = directory?.trim()
  if (explicit) return expandHomePath(explicit, home)
  return defaultChannelDirectory(channelName, configDir)
}

/** Ensure the channel work directory exists (mkdir -p). */
export async function ensureChannelDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive: true })
  } catch (err) {
    log.warn("failed to create channel directory", { directory, error: err })
    throw err
  }
}
