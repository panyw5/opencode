/**
 * IM channels config lives in a dedicated file under the config dir:
 *   `{Global.Path.config}/channels.json`
 *
 * Rationale: official OpenCode CLI rejects unknown top-level keys in
 * opencode.jsonc (e.g. "channels"). Keeping IM settings out of that file
 * preserves dual-use with the upstream CLI while this fork still exposes
 * channels on Config.Info / global.config in memory and over the API.
 */
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Schema } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import { ConfigChannels } from "./channels"
import { ConfigParse } from "./parse"
import { isRecord } from "@/util/record"

export const CHANNELS_FILENAME = "channels.json"

/** On-disk shape: the channels map itself (not nested under a "channels" key). */
export const FileSchema = Schema.Record(Schema.String, ConfigChannels.Info)
export type ChannelsMap = Schema.Schema.Type<typeof FileSchema>

export function channelsFilePath(configDir = Global.Path.config) {
  return path.join(configDir, CHANNELS_FILENAME)
}

/** Global config files that may still contain a legacy top-level `channels` key. */
export function mainConfigCandidates(configDir = Global.Path.config) {
  return ["opencode.jsonc", "opencode.json", "config.json"].map((file) => path.join(configDir, file))
}

export function parseChannelsText(text: string, source: string): ChannelsMap {
  const trimmed = text.trim()
  if (!trimmed) return {}
  const data = ConfigParse.jsonc(text, source)
  if (data === null || data === undefined) return {}
  // Allow accidental wrap `{ "channels": { ... } }` from hand edits.
  const unwrapped =
    isRecord(data) && isRecord(data.channels) && !("type" in data) ? data.channels : data
  return ConfigParse.schema(FileSchema, unwrapped, source) as ChannelsMap
}

/** Remove top-level `channels` from a JSON/JSONC document string. Returns original if absent. */
export function stripChannelsKey(text: string): string {
  if (!text.includes("channels")) return text
  try {
    const data = ConfigParse.jsonc(text, "strip-channels")
    if (!isRecord(data) || !("channels" in data)) return text
  } catch {
    return text
  }
  const edits = modify(text, ["channels"], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  if (!edits.length) return text
  return applyEdits(text, edits)
}

export function serializeChannels(channels: ChannelsMap): string {
  return JSON.stringify(channels ?? {}, null, 2) + "\n"
}
