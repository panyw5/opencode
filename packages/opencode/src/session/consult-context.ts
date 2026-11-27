import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Option } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import { formatProjectTaskFullContext } from "@/project-task/context"
import { projectTaskContextLocale } from "@/project-task/context-copy"
import { ProjectTask } from "@/project-task/service"
import { getContextLocale } from "./context-locale"
import type { MessageV2 } from "./message-v2"
import { Session } from "./session"

const log = Log.create({ service: "session.consult-context" })

/** How much session context a direct @-mention consult forwards to the external agent. */
export const LEVELS = ["none", "files", "task", "recent"] as const
export type Level = (typeof LEVELS)[number]
export const DEFAULT_LEVEL: Level = "task"

const rank = (level: Level) => LEVELS.indexOf(level)

const FILE_CONTENT_LIMIT = 32 * 1024
const FILE_READ_LIMIT = 4 * FILE_CONTENT_LIMIT
const FILES_TOTAL_LIMIT = 96 * 1024
const DIRECTORY_ENTRIES_LIMIT = 50
const DIGEST_MESSAGES = 10
const DIGEST_ENTRY_LIMIT = 800
const DIGEST_TOTAL_LIMIT = 16 * 1024

const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/toml",
])
const TEXT_EXTENSIONS = /\.(md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|h|cpp|hpp|cs|rb|sh|bash|zsh|fish|json|jsonc|yaml|yml|toml|xml|html|css|scss|less|sql|tex|wls|wl|m|nb|ini|cfg|conf|env|csv|tsv|log|diff|patch|vue|svelte)$/i

export interface FileEntry {
  path: string
  kind: "file" | "directory" | "other"
  content?: string
  truncated?: boolean
  entries?: string[]
  note?: string
}

export interface DigestEntry {
  role: "user" | "assistant"
  text: string
}

export interface Package {
  directory?: string
  sessionTitle?: string
  files: FileEntry[]
  taskBrief?: string
  digest: DigestEntry[]
}

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value)
}

function filePartPath(part: MessageV2.Part): string | undefined {
  if (part.type !== "file") return undefined
  const source = part.source
  if (source && source.type !== "resource" && source.path.trim()) return source.path
  if (part.url.startsWith("file:")) {
    try {
      return fileURLToPath(part.url)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Decode `data:` URL attachments (the server inlines file part content as data URLs). */
function decodeDataText(part: MessageV2.FilePart): string | undefined {
  if (!part.url.startsWith("data:")) return undefined
  const comma = part.url.indexOf(",")
  if (comma < 0) return undefined
  const meta = part.url.slice(5, comma)
  const mime = meta.split(";")[0] || part.mime
  if (!mime.startsWith("text/") && !TEXT_MIMES.has(mime)) return undefined
  try {
    const buf = meta.endsWith(";base64")
      ? Buffer.from(part.url.slice(comma + 1), "base64")
      : Buffer.from(decodeURIComponent(part.url.slice(comma + 1)))
    if (buf.length > FILE_READ_LIMIT) return undefined
    return buf.toString("utf8")
  } catch {
    return undefined
  }
}

const materializeFiles = Effect.fnUntraced(function* (parts: readonly MessageV2.Part[]) {
  const entries: FileEntry[] = []
  const seen = new Set<string>()
  let inlined = 0
  const fsys = Option.getOrUndefined(yield* Effect.serviceOption(AppFileSystem.Service))

  for (const part of parts) {
    if (part.type !== "file") continue
    const filepath = filePartPath(part)
    if (!filepath) {
      const label = part.filename?.trim() || (part.url.startsWith("data:") ? "attachment" : part.url)
      const decoded = decodeDataText(part)
      if (decoded === undefined) {
        entries.push({ path: label, kind: "other", note: `external or non-file resource (${part.mime}) — content not embedded` })
        continue
      }
      if (inlined >= FILES_TOTAL_LIMIT) {
        entries.push({ path: label, kind: "file", note: "omitted — referenced-files size budget reached" })
        continue
      }
      const truncated = decoded.length > FILE_CONTENT_LIMIT
      const content = truncated ? decoded.slice(0, FILE_CONTENT_LIMIT) : decoded
      inlined += content.length
      entries.push({ path: label, kind: "file", content, truncated })
      continue
    }
    const resolved = path.resolve(filepath)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    if (!fsys) {
      entries.push({ path: resolved, kind: "file", note: "content unavailable" })
      continue
    }

    const info = Option.getOrUndefined(yield* fsys.stat(resolved).pipe(Effect.option))
    if (!info) {
      entries.push({ path: resolved, kind: "file", note: "not found" })
      continue
    }
    if (info.type === "Directory") {
      const listing = yield* fsys
        .readDirectoryEntries(resolved)
        .pipe(Effect.catch(() => Effect.succeed([] as { name: string; type: string }[])))
      entries.push({
        path: resolved,
        kind: "directory",
        entries: listing.slice(0, DIRECTORY_ENTRIES_LIMIT).map((e) => e.name + (e.type === "directory" ? "/" : "")),
        note: listing.length > DIRECTORY_ENTRIES_LIMIT ? `…and ${listing.length - DIRECTORY_ENTRIES_LIMIT} more` : undefined,
      })
      continue
    }
    if (info.type !== "File") {
      entries.push({ path: resolved, kind: "other", note: `special filesystem entry (${info.type})` })
      continue
    }
    const texty = part.mime.startsWith("text/") || TEXT_MIMES.has(part.mime) || TEXT_EXTENSIONS.test(resolved)
    if (!texty) {
      entries.push({ path: resolved, kind: "file", note: `binary file (${part.mime}) — content not embedded` })
      continue
    }
    const bytes = Number(info.size)
    if (bytes > FILE_READ_LIMIT) {
      entries.push({
        path: resolved,
        kind: "file",
        note: `text file too large (${Math.round(bytes / 1024)} KB) — content omitted`,
      })
      continue
    }
    if (inlined >= FILES_TOTAL_LIMIT) {
      entries.push({ path: resolved, kind: "file", note: "omitted — referenced-files size budget reached" })
      continue
    }
    const text = Option.getOrUndefined(yield* fsys.readFileString(resolved).pipe(Effect.option))
    if (text === undefined) {
      entries.push({ path: resolved, kind: "file", note: "unreadable as UTF-8 text" })
      continue
    }
    const truncated = text.length > FILE_CONTENT_LIMIT
    const content = truncated ? text.slice(0, FILE_CONTENT_LIMIT) : text
    inlined += content.length
    entries.push({ path: resolved, kind: "file", content, truncated })
  }
  return entries
})

const taskBrief = Effect.fnUntraced(function* (session: Session.Info) {
  if (!session.mountedTaskID) return undefined
  const service = Option.getOrUndefined(yield* Effect.serviceOption(ProjectTask.Service))
  if (!service) return undefined
  const detail = Option.getOrUndefined(
    yield* service.detail(session.mountedTaskID).pipe(
      Effect.option,
      Effect.catch(() => Effect.succeed(Option.none())),
    ),
  )
  if (!detail) return undefined
  const locale = projectTaskContextLocale(getContextLocale(session.id))
  return formatProjectTaskFullContext({ detail, audience: "external", locale })
})

export function digestMessages(msgs: readonly MessageV2.WithParts[], excludeMessageID?: string): DigestEntry[] {
  const entries: DigestEntry[] = []
  let total = 0
  for (let i = msgs.length - 1; i >= 0 && entries.length < DIGEST_MESSAGES; i--) {
    const msg = msgs[i]
    if (msg.info.id === excludeMessageID) continue
    const role = msg.info.role
    if (role !== "user" && role !== "assistant") continue
    const text = msg.parts
      .filter(
        (part): part is MessageV2.TextPart =>
          part.type === "text" && !part.synthetic && !part.ignored && !!part.text?.trim(),
      )
      .map((part) => part.text.trim())
      .join("\n")
    if (!text) continue
    const clipped = text.length > DIGEST_ENTRY_LIMIT ? `${text.slice(0, DIGEST_ENTRY_LIMIT)}…` : text
    if (total + clipped.length > DIGEST_TOTAL_LIMIT) break
    total += clipped.length
    entries.push({ role, text: clipped })
  }
  return entries.reverse()
}

/** Assemble the portable context package for an external consult. */
export const build = Effect.fn("ConsultContext.build")(function* (input: {
  session: Session.Info
  msgs: readonly MessageV2.WithParts[]
  /** Parts to materialize `file` entries from (empty array disables inlining). */
  fileParts: readonly MessageV2.Part[]
  excludeMessageID?: string
  level: Level
  directory: string
}) {
  const pkg: Package = { files: [], digest: [] }
  const level = rank(input.level)
  if (level === 0) return pkg

  pkg.directory = input.directory
  if (!Session.isDefaultTitle(input.session.title)) pkg.sessionTitle = input.session.title

  if (level >= rank("files") && input.fileParts.length) {
    pkg.files = yield* materializeFiles(input.fileParts)
  }
  if (level >= rank("task")) {
    pkg.taskBrief = yield* taskBrief(input.session).pipe(
      Effect.catch((error) => {
        log.warn(`task brief failed session=${input.session.id} error=${String(error)}`)
        return Effect.succeed(undefined)
      }),
    )
  }
  if (level >= rank("recent")) {
    pkg.digest = digestMessages(input.msgs, input.excludeMessageID)
  }
  log.info(
    `built level=${input.level} files=${pkg.files.length} brief=${!!pkg.taskBrief} digest=${pkg.digest.length} session=${input.session.id}`,
  )
  return pkg
})

/** Serialize the context package ahead of the consult prompt. */
export function serialize(pkg: Package, prompt: string): string {
  const sections: string[] = []

  if (pkg.directory || pkg.sessionTitle) {
    const facts = [
      pkg.directory ? `Working directory: ${pkg.directory}` : undefined,
      pkg.sessionTitle ? `Session topic: ${pkg.sessionTitle}` : undefined,
    ].filter(Boolean)
    sections.push(facts.join("\n"))
  }

  if (pkg.files.length) {
    const blocks = pkg.files.map((file) => {
      if (file.kind === "directory") {
        const body = [...(file.entries ?? []).map((name) => `- ${name}`), ...(file.note ? [file.note] : [])].join("\n")
        return `<directory path="${file.path}">\n${body}\n</directory>`
      }
      const body = file.content ?? `(${file.note ?? "content unavailable"})`
      return `<file path="${file.path}"${file.truncated ? ' truncated="true"' : ""}>\n${body}\n</file>`
    })
    sections.push(`<referenced-files>\n${blocks.join("\n")}\n</referenced-files>`)
  }

  if (pkg.taskBrief) sections.push(pkg.taskBrief)

  if (pkg.digest.length) {
    const lines = pkg.digest.map((entry) => `${entry.role}:\n${entry.text}`).join("\n\n")
    sections.push(`<recent-conversation>\n${lines}\n</recent-conversation>`)
  }

  if (!sections.length) return prompt
  return `<opencode-context>\n${sections.join("\n\n")}\n</opencode-context>\n\n${prompt}`
}

/** Resolve the configured context level for an advisor mention. */
export function levelFor(
  config:
    | {
        pi?: { context?: unknown }
        external_agents?: Record<string, { context?: unknown } | undefined>
      }
    | undefined,
  advisor: string,
): Level {
  const configured = advisor === "pi" ? config?.pi?.context : config?.external_agents?.[advisor]?.context
  return isLevel(configured) ? configured : DEFAULT_LEVEL
}

export * as ConsultContext from "./consult-context"
