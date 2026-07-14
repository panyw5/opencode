import path from "path"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "channel.mapping" })

export type ChannelSessionMap = {
  /** key: `${channelName}::${chatId}[::${threadId}]` → sessionId */
  sessions: Record<string, string>
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
