import path from "path"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "channel.mapping" })

export type ChannelSessionEntry = {
  sessionId: string
  /** Work directory the session was created under (channel-owned). */
  directory: string
}

export type ChannelSessionMap = {
  /**
   * key: `${channelName}::${chatId}[::${threadId}]`
   * value: sessionId (legacy string) or { sessionId, directory }
   */
  sessions: Record<string, string | ChannelSessionEntry>
}

function mapPath() {
  return path.join(Global.Path.state, "channel-sessions.json")
}

export async function loadMap(): Promise<ChannelSessionMap> {
  const file = mapPath()
  try {
    const raw = await fs.readFile(file, "utf8")
    const parsed = JSON.parse(raw) as ChannelSessionMap
    if (!parsed || typeof parsed.sessions !== "object" || !parsed.sessions) return { sessions: {} }
    return parsed
  } catch {
    return { sessions: {} }
  }
}

export async function saveMap(map: ChannelSessionMap): Promise<void> {
  const file = mapPath()
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(map, null, 2), "utf8")
  } catch (err) {
    log.warn("failed to save channel session map", { error: err })
  }
}

export function sessionKey(input: {
  channelName: string
  chatId: string
  threadId?: string
}): string {
  return input.threadId
    ? `${input.channelName}::${input.chatId}::${input.threadId}`
    : `${input.channelName}::${input.chatId}`
}

export function titlePrefix(channelName: string): string {
  return `[im:${channelName}]`
}

/**
 * Resolve a mapping entry for the current channel work directory.
 * Legacy string values (sessionId only) are treated as mismatched when a
 * directory is required — caller should create a new session.
 */
export function resolveMappedSession(
  entry: string | ChannelSessionEntry | undefined,
  directory: string,
): string | undefined {
  if (!entry) return undefined
  if (typeof entry === "string") {
    // Legacy: no directory recorded — only reuse if we cannot compare (caller may pass "").
    if (!directory) return entry
    return undefined
  }
  if (entry.directory === directory) return entry.sessionId
  return undefined
}

export function mappedEntry(sessionId: string, directory: string): ChannelSessionEntry {
  return { sessionId, directory }
}
