import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import * as Database from "@/storage/db"
import { and, desc, eq, lt, like, sql } from "drizzle-orm"
import { InstanceState } from "@/effect/instance-state"
import { MessageTable } from "@/session/session.sql"
import { IssueOccurrenceTable, IssueTable } from "./issue.sql"

const log = Log.create({ service: "issue" })
const Finite = Schema.Number.check(Schema.isFinite())
export const State = Schema.Literals(["recorded", "recovering", "needs_user", "failed", "resolved", "cancelled"])
export const Info = Schema.Struct({
  id: Schema.String,
  directory: Schema.String,
  domain: Schema.String,
  sessionID: Schema.optional(Schema.String),
  messageID: Schema.optional(Schema.String),
  toolCallID: Schema.optional(Schema.String),
  code: Schema.String,
  source: Schema.String,
  scope: Schema.Literals(["tool", "session", "project", "application"]),
  state: State,
  message: Schema.String,
  details: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  createdAt: Finite,
  updatedAt: Finite,
  readAt: Schema.optional(Finite),
  acknowledgedAt: Schema.optional(Finite),
  storage: Schema.Literals(["database", "fallback"]),
  occurrences: Finite,
})
export type Info = Schema.Schema.Type<typeof Info>
export const Occurrence = Schema.Struct({
  id: Schema.String,
  time: Finite,
  state: State,
  message: Schema.String,
  details: Schema.optional(Schema.String),
})
export type Occurrence = Schema.Schema.Type<typeof Occurrence>
export const Event = {
  Updated: BusEvent.define("issue.updated", Schema.Struct({ issue: Info, notify: Schema.Boolean })),
}

type Input = Pick<Info, "code" | "source" | "scope" | "state" | "message"> &
  Partial<Pick<Info, "id" | "domain" | "sessionID" | "messageID" | "toolCallID" | "details" | "action">> & {
    key?: string
    occurrenceKey?: string
    silent?: boolean
  }

export function redact(value: string) {
  return value
    .replace(/(Bearer\s+)[^\s"',;}]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@")
}

export function needsAttention(issue: Pick<Info, "scope" | "state">) {
  return issue.state === "needs_user" || (issue.state === "failed" && issue.scope !== "tool")
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
function fallbackPath() {
  return path.join(Global.Path.data, "issue-fallback.jsonl")
}

function publish(issue: Info, notify: boolean) {
  try {
    GlobalBus.emit("event", {
      directory: issue.directory,
      payload: { type: Event.Updated.type, properties: { issue, notify } },
    })
  } catch (error) {
    log.error("issue broadcast failed; durable record retained", { id: issue.id, reason: redact(String(error)) })
  }
}

function fallbackRecords(): { issue: Info; occurrence: Occurrence }[] {
  try {
    return readFileSync(fallbackPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as { issue: Info; occurrence: Occurrence }]
        } catch {
          log.error("incomplete fallback entry; original journal retained")
          return []
        }
      })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log.error("fallback read failed", { reason: redact(String(error)) })
    return []
  }
}

function save(issue: Info, occurrence: Occurrence) {
  Database.transaction((db) => {
    db.insert(IssueTable)
      .values({
        id: issue.id,
        directory: issue.directory,
        session_id: issue.sessionID,
        time_updated: issue.updatedAt,
        data: issue,
      })
      .onConflictDoUpdate({ target: IssueTable.id, set: { time_updated: issue.updatedAt, data: issue } })
      .run()
    db.insert(IssueOccurrenceTable)
      .values({ id: occurrence.id, issue_id: issue.id, data: occurrence })
      .onConflictDoNothing()
      .run()
  })
}

function replay() {
  let text: string
  try {
    text = readFileSync(fallbackPath(), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  for (const line of text.split("\n").filter(Boolean)) {
    const item = JSON.parse(line) as { issue: Info; occurrence: Occurrence }
    const current = Database.use((db) => db.select().from(IssueTable).where(eq(IssueTable.id, item.issue.id)).get())
    const issue =
      current && current.data.updatedAt > item.issue.updatedAt
        ? current.data
        : { ...item.issue, storage: "database" as const }
    save(issue, item.occurrence)
  }
  renameSync(fallbackPath(), `${fallbackPath()}.replayed-${randomUUID()}`)
  log.info("fallback replay completed")
}

export function list(
  input: {
    directory?: string
    sessionID?: string
    before?: string
    limit?: number
    domain?: string
    attention?: boolean
  } = {},
) {
  try {
    replay()
    const rows = Database.use((db) =>
      db
        .select()
        .from(IssueTable)
        .where(
          and(
            input.directory === undefined ? undefined : eq(IssueTable.directory, input.directory),
            input.sessionID === undefined ? undefined : eq(IssueTable.session_id, input.sessionID),
            input.before === undefined ? undefined : lt(IssueTable.id, input.before),
            input.attention
              ? sql`(json_extract(${IssueTable.data}, '$.state') = 'needs_user' OR (json_extract(${IssueTable.data}, '$.state') = 'failed' AND json_extract(${IssueTable.data}, '$.scope') != 'tool')) AND json_extract(${IssueTable.data}, '$.acknowledgedAt') IS NULL`
              : undefined,
          ),
        )
        .orderBy(desc(IssueTable.id))
        .limit(Math.max(1, Math.min(input.limit ?? 50, 100)))
        .all(),
    )
    return rows.map((row) => row.data).filter((item) => !input.domain || item.domain === input.domain)
  } catch (error) {
    log.error("database query unavailable; reading fallback", { reason: redact(String(error)) })
    const items = new Map(fallbackRecords().map((item) => [item.issue.id, item.issue]))
    return [...items.values()]
      .filter(
        (item) =>
          (!input.directory || item.directory === input.directory) &&
          (!input.sessionID || item.sessionID === input.sessionID) &&
          (!input.before || item.id < input.before) &&
          (!input.domain || item.domain === input.domain) &&
          (!input.attention || (needsAttention(item) && !item.acknowledgedAt)),
      )
      .sort((a, b) => b.id.localeCompare(a.id))
      .slice(0, Math.max(1, Math.min(input.limit ?? 50, 100)))
  }
}

export function get(id: string) {
  try {
    replay()
    const issue = Database.use((db) => db.select().from(IssueTable).where(eq(IssueTable.id, id)).get())?.data
    if (!issue) return
    const history = Database.use((db) =>
      db
        .select()
        .from(IssueOccurrenceTable)
        .where(eq(IssueOccurrenceTable.issue_id, id))
        .orderBy(IssueOccurrenceTable.id)
        .all(),
    )
      .map((row) => row.data)
      .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
    return { issue, history }
  } catch (error) {
    log.error("database detail unavailable; reading fallback", { id, reason: redact(String(error)) })
    const records = fallbackRecords().filter((item) => item.issue.id === id)
    if (!records.length) return
    return { issue: records.at(-1)!.issue, history: records.map((item) => item.occurrence) }
  }
}

export function record(directory: string, input: Input) {
  const now = Date.now()
  const id =
    input.id ??
    `iss_${String(now).padStart(13, "0")}_${digest(JSON.stringify([directory, input.domain ?? "opencode", input.sessionID, input.key ?? input.messageID, input.toolCallID, input.code, input.source])).slice(0, 24)}`
  // A stable operation key deduplicates the same failure crossing multiple boundaries.
  const key = id.slice(id.lastIndexOf("_") + 1)
  let previous: Info | undefined
  try {
    replay()
    previous = input.id
      ? get(input.id)?.issue
      : Database.use((db) =>
          db
            .select()
            .from(IssueTable)
            .where(and(eq(IssueTable.directory, directory), like(IssueTable.id, `%_${key}`)))
            .orderBy(desc(IssueTable.id))
            .limit(1)
            .get(),
        )?.data
  } catch (error) {
    log.error("issue lookup failed; using fallback", { reason: redact(String(error)) })
    previous = fallbackRecords()
      .reverse()
      .find((item) => (input.id ? item.issue.id === input.id : item.issue.id.endsWith(`_${key}`)))?.issue
  }
  if (previous && previous.state === input.state && !input.occurrenceKey) return { issue: previous, notify: false }
  let issue: Info = {
    ...previous,
    id: previous?.id ?? id,
    directory,
    domain: input.domain ?? "opencode",
    sessionID: input.sessionID,
    messageID: input.messageID,
    toolCallID: input.toolCallID,
    code: input.code,
    source: input.source,
    scope: input.scope,
    state: input.state,
    message: redact(input.message),
    details: input.details ? redact(input.details) : undefined,
    action: input.action ? redact(input.action) : undefined,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    storage: "database",
    occurrences: (previous?.occurrences ?? 0) + 1,
  }
  if (needsAttention(issue) && previous && !needsAttention(previous)) {
    issue = { ...issue, readAt: undefined, acknowledgedAt: undefined }
  }
  const occurrence: Occurrence = {
    id: input.occurrenceKey ? `ioc_${digest(`${issue.id}:${input.occurrenceKey}`)}` : `ioc_${now}_${randomUUID()}`,
    time: now,
    state: issue.state,
    message: issue.message,
    details: issue.details,
  }
  if (input.occurrenceKey && previous) {
    try {
      if (
        Database.use((db) =>
          db.select().from(IssueOccurrenceTable).where(eq(IssueOccurrenceTable.id, occurrence.id)).get(),
        )
      )
        return { issue: previous, notify: false }
    } catch {
      /* The fallback journal remains the source of truth while SQLite is unavailable. */
    }
  }
  try {
    save(issue, occurrence)
  } catch (error) {
    issue = { ...issue, storage: "fallback" }
    log.error("issue storage failed; appending fallback", { id: issue.id, reason: redact(String(error)) })
    try {
      mkdirSync(Global.Path.data, { recursive: true })
      appendFileSync(fallbackPath(), JSON.stringify({ issue, occurrence }) + "\n", { mode: 0o600 })
    } catch (fallback) {
      log.error("issue fallback failed", { id: issue.id, reason: redact(String(fallback)), message: issue.message })
    }
  }
  const notify = !input.silent && needsAttention(issue) && (!previous || !needsAttention(previous))
  log.info("issue recorded", {
    id: issue.id,
    scope: issue.scope,
    state: issue.state,
    code: issue.code,
    notify,
    storage: issue.storage,
  })
  publish(issue, notify)
  return { issue, notify }
}

export const report = Effect.fn("Issue.report")(function* (input: Input) {
  const ctx = yield* InstanceState.context
  return record(ctx.directory, input)
})

export function mark(id: string, action: "read" | "acknowledge") {
  const current = get(id)
  if (!current) return
  const issue = { ...current.issue, ...(action === "read" ? { readAt: Date.now() } : { acknowledgedAt: Date.now() }) }
  Database.use((db) => db.update(IssueTable).set({ data: issue }).where(eq(IssueTable.id, id)).run())
  log.info("issue marked", { id, action, state: issue.state })
  publish(issue, false)
  return issue
}

export const settle = Effect.fn("Issue.settle")(function* (
  sessionID: string,
  state: "resolved" | "failed" | "cancelled",
  message: string,
) {
  const ctx = yield* InstanceState.context
  for (const item of list({ directory: ctx.directory, sessionID, limit: 100 }).filter(
    (item) => item.state === "recovering" || (item.state === "needs_user" && item.source === "provider"),
  )) {
    record(ctx.directory, { ...item, state, message })
  }
})

export const fromSessionError = Effect.fn("Issue.fromSessionError")(function* (input: {
  sessionID?: string
  error?: unknown
}) {
  const error = input.error as { name?: string; data?: { message?: string } } | undefined
  const message =
    error?.data?.message ?? (typeof input.error === "string" ? input.error : (error?.name ?? "Unknown session failure"))
  const state =
    error?.name === "MessageAbortedError"
      ? "cancelled"
      : error?.name === "ContextOverflowError"
        ? "recovering"
        : "failed"
  const row = (() => {
    try {
      return input.sessionID
        ? Database.use((db) =>
            db
              .select()
              .from(MessageTable)
              .where(
                and(
                  eq(MessageTable.session_id, input.sessionID as never),
                  state === "recovering" ? sql`json_extract(${MessageTable.data}, '$.role') = 'user'` : undefined,
                ),
              )
              .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
              .limit(1)
              .get(),
          )
        : undefined
    } catch (error) {
      log.error("message ownership lookup failed", { reason: redact(String(error)) })
      return undefined
    }
  })()
  const ctx = yield* InstanceState.context
  const recovery =
    state === "failed" && input.sessionID
      ? list({ directory: ctx.directory, sessionID: input.sessionID }).find(
          (item) => item.state === "recovering" || (item.state === "needs_user" && item.source === "provider"),
        )
      : undefined
  return yield* report({
    ...recovery,
    source: recovery?.source ?? "session",
    scope: input.sessionID ? "session" : "application",
    sessionID: input.sessionID,
    messageID: recovery?.messageID ?? row?.id,
    code:
      recovery?.code ??
      (state === "cancelled" ? "run.cancelled" : state === "recovering" ? "context.overflow" : "run.failed"),
    state,
    message,
    action:
      state === "failed"
        ? "Review this error and the recovery history. Check provider settings if authentication failed, then retry from the session."
        : undefined,
  })
})

export const interaction = Effect.fn("Issue.interaction")(function* (
  type: string,
  properties: {
    id?: string
    requestID?: string
    sessionID?: string
    permission?: string
    reply?: string
    questions?: { question: string }[]
  },
) {
  const id = `iss_request_${properties.id ?? properties.requestID}`
  if (type.endsWith(".asked")) {
    return yield* report({
      id,
      source: type.split(".")[0],
      scope: "session",
      code: type,
      state: "needs_user",
      sessionID: properties.sessionID,
      message: properties.permission
        ? `Permission required: ${properties.permission}`
        : (properties.questions?.map((item) => item.question).join("\n") ?? "User input required"),
      action: "Respond using the permission or question controls in the session.",
      silent: true,
    })
  }
  const previous = get(id)?.issue
  if (!previous) return
  return yield* report({
    ...previous,
    state: type.endsWith(".rejected") || properties.reply === "reject" ? "cancelled" : "resolved",
    message:
      type.endsWith(".rejected") || properties.reply === "reject"
        ? "The user declined the request."
        : "The user responded to the request.",
    silent: true,
  })
})

export * as Issue from "./issue"
