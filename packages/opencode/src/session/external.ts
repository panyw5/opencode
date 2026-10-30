import { createHash } from "node:crypto"
import { Cause, Effect, Option, Semaphore } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import * as Log from "@opencode-ai/core/util/log"
import { pathIdentityKey } from "@opencode-ai/core/util/path"
import type { Tool } from "@/tool/tool"
import type { Truncate } from "@/tool/truncate"
import {
  advisorInterventionSnapshot,
  closeAdvisorIntervention,
  finishAdvisorIntervention,
  sendAdvisorIntervention,
  startAdvisorIntervention,
} from "@/tool/advisor-intervention"
import { Session } from "./session"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, SessionID } from "./schema"
import type { Advisor, ExternalSessionState } from "./external-schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { externalConversationOutput } from "./external-handoff"

export { externalConversationOutput } from "./external-handoff"

const log = Log.create({ service: "session.external" })
const creationLock = Semaphore.makeUnsafe(1)
const importLock = Semaphore.makeUnsafe(1)
const active = new Map<string, { abort: AbortController; parentID: SessionID; callID: string; intervened: boolean }>()
const advisors: Record<string, Advisor> = {
  codex_consult: "codex",
  claude_consult: "claude",
  grok_consult: "grok",
  dsh_consult: "dsh",
  pi_consult: "pi",
}

export type TranscriptItem = { id: string; kind: string; title?: string; text?: string; status?: string }

export function externalSessionID(parentID: string, partID: string) {
  return SessionID.make(
    `ses_external_${createHash("sha256").update(`${parentID}:${partID}`).digest("hex").slice(0, 32)}`,
  )
}

export function attachExternalTranscript(
  ctx: Pick<Tool.Context, "extra">,
  state: { onTranscript?: (item: TranscriptItem) => void },
) {
  state.onTranscript = ctx.extra?.externalTranscript as typeof state.onTranscript
}

export function makeExternalSessions(
  sessions: Session.Interface,
  statuses: SessionStatus.Interface,
  normalizeOutput?: (output: string, ctx: Tool.Context) => Effect.Effect<Truncate.Result>,
  canReadTranscript?: (ctx: Tool.Context, parent: Session.Info) => Effect.Effect<boolean>,
) {
  const ensure = (parent: Session.Info, source: MessageV2.WithParts, part: MessageV2.ToolPart, historical: boolean) =>
    creationLock.withPermit(
      Effect.gen(function* () {
        const advisor = advisors[part.tool]
        if (!advisor) throw new Error("Not an external CLI consultation")
        const id = externalSessionID(parent.id, part.id)
        const existing = yield* sessions.get(id).pipe(Effect.option)
        if (Option.isSome(existing)) return existing.value
        const prompt = typeof part.state.input.prompt === "string" ? part.state.input.prompt : ""
        const child = yield* sessions.create({
          id,
          parentID: parent.id,
          workspaceID: parent.workspaceID,
          title: `${advisor}: ${prompt.trim().split("\n")[0]?.slice(0, 100) || "Consultation"}`,
          agent: advisor,
          external: {
            advisor,
            sourceMessageID: source.info.id,
            sourcePartID: part.id,
            callID: part.callID,
            historical,
            ...(!historical ? { ownerPID: process.pid } : {}),
          },
        })
        log.info(
          `created parent=${parent.id} child=${child.id} part=${part.id} advisor=${advisor} historical=${historical}`,
        )
        return child
      }),
    )

  const project = (child: Session.Info, source: MessageV2.WithParts, prompt: string, selectedModel?: string) => {
    const sourcePart = source.parts.find((part) => part.id === child.external?.sourcePartID)
    const modelName =
      selectedModel ??
      (sourcePart?.type === "tool" && typeof sourcePart.state.input.model === "string"
        ? sourcePart.state.input.model
        : "default")
    // External CLIs own model selection. Never label their messages with the parent's model.
    const model = {
      providerID: ProviderID.make(`external-${child.external!.advisor}`),
      modelID: ModelID.make(modelName),
    }
    const lock = Semaphore.makeUnsafe(1)
    const pending = new Map<string, TranscriptItem>()
    const written = new Map<string, string>()
    const parts = new Map<string, { id: PartID; messageID: MessageID; start: number }>()
    const assistants: MessageV2.Assistant[] = []
    let userID: MessageID
    let assistant: MessageV2.Assistant
    let initialized = false
    let finalized = false

    const turn = (text: string) =>
      Effect.gen(function* () {
        if (assistant) {
          assistant.time.completed = Date.now()
          yield* sessions.updateMessage(assistant)
        }
        userID = MessageID.ascending()
        yield* sessions.updateMessage({
          id: userID,
          sessionID: child.id,
          role: "user",
          agent: child.agent!,
          model,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: child.id,
          messageID: userID,
          type: "text",
          text,
        })
        assistant = {
          id: MessageID.ascending(),
          sessionID: child.id,
          role: "assistant",
          parentID: userID,
          agent: child.agent!,
          mode: child.agent!,
          ...model,
          path: { cwd: child.directory, root: child.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        }
        assistants.push(assistant)
        yield* sessions.updateMessage(assistant)
      })

    const flush = (items: readonly TranscriptItem[], final = false, error?: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (finalized && !final) return
          if (!initialized) {
            yield* turn(prompt)
            initialized = true
          }
          for (const item of items) pending.set(item.id, { ...pending.get(item.id), ...item })
          for (const [key, item] of pending) {
            const signature = JSON.stringify([item, final])
            if (written.get(key) === signature) continue
            if (item.kind === "user") {
              if (!written.has(key) && key !== "user:initial") yield* turn(item.text ?? "")
              written.set(key, signature)
              continue
            }
            const ref = parts.get(key) ?? { id: PartID.ascending(), messageID: assistant.id, start: Date.now() }
            parts.set(key, ref)
            const base = { id: ref.id, sessionID: child.id, messageID: ref.messageID }
            const time = {
              start: ref.start,
              ...(final || item.status === "completed" || item.status === "error" ? { end: Date.now() } : {}),
            }
            const completedText =
              item.kind === "status" &&
              item.title === "Turn completed" &&
              item.text?.trim() &&
              !/^in=\d+\s+out=\d+/.test(item.text.trim())
            const duplicateText =
              completedText &&
              [...pending.values()].some(
                (other) => other.kind === "message" && other.text?.trim() === item.text?.trim(),
              )
            if (duplicateText) {
              written.set(key, signature)
              continue
            }
            if (item.kind === "message" || completedText) {
              yield* sessions.updatePart({
                ...base,
                type: "text",
                text: item.text ?? "",
                time,
                metadata: { externalEvent: key },
              })
            } else if (item.kind === "reasoning" || item.kind === "thinking") {
              yield* sessions.updatePart({ ...base, type: "reasoning", text: item.text ?? "", time })
            } else {
              // These are observed external events, never locally executable tools.
              const running = !final && (item.status === "running" || item.status === "pending")
              const metadata = { external: true, title: item.title ?? item.kind, status: item.status }
              yield* sessions.updatePart({
                ...base,
                type: "tool",
                callID: `external:${key}`,
                tool: `external_${item.kind}`,
                state: running
                  ? {
                      status: "running",
                      input: {},
                      title: item.title ?? item.kind,
                      metadata: { ...metadata, output: item.text ?? "" },
                      time: { start: ref.start },
                    }
                  : {
                      status: "completed",
                      input: {},
                      title: item.title ?? item.kind,
                      output: item.text ?? "",
                      metadata,
                      time: { start: ref.start, end: Date.now() },
                    },
              })
            }
            written.set(key, signature)
          }
          if (final) {
            finalized = true
            for (const msg of assistants) {
              msg.time.completed ??= Date.now()
              msg.finish = "stop"
              if (msg === assistant && error) msg.error = { name: "UnknownError", data: { message: error } }
              yield* sessions.updateMessage(msg)
            }
            yield* statuses.set(child.id, { type: "idle" })
          }
          log.debug(`projected child=${child.id} items=${pending.size} final=${final} error=${!!error}`)
        }),
      )
    return { flush }
  }

  const wrap = (tool: Tool.Def): Tool.Def => {
    if (!advisors[tool.id]) return tool
    return {
      ...tool,
      execute: (args, ctx) =>
        Effect.gen(function* () {
          const parent = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          const source = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
          const part = source.parts.find(
            (part): part is MessageV2.ToolPart => part.type === "tool" && part.callID === ctx.callID,
          )
          if (!part) throw new Error("External consultation source tool part is missing")
          const bridge = yield* EffectBridge.make()
          const directory = yield* InstanceState.directory
          const controller = new AbortController()
          const abort = () => controller.abort(ctx.abort.reason)
          if (ctx.abort.aborted) abort()
          ctx.abort.addEventListener("abort", abort, { once: true })
          let child: Session.Info | undefined
          let projection: ReturnType<typeof project> | undefined
          const captured = new Map<string, TranscriptItem>()
          let lastMetadata: Record<string, any> = {}
          let closed = false
          let streamCaptured = false
          const key = `${pathIdentityKey(directory)}:${externalSessionID(parent.id, part.id)}`
          const initialize = yield* Effect.cached(
            Effect.gen(function* () {
              active.set(key, { abort: controller, parentID: parent.id, callID: part.callID, intervened: false })
              child = yield* ensure(parent, source, part, false)
              projection = project(
                child,
                source,
                String((args as Record<string, unknown>).prompt ?? ""),
                typeof lastMetadata.model === "string" ? lastMetadata.model : undefined,
              )
              yield* statuses.set(child.id, { type: "busy" })
              return child
            }),
          )
          const metadata: Tool.Context["metadata"] = (value) =>
            Effect.promise(() =>
              bridge.promise(
                Effect.gen(function* () {
                  if (closed) return
                  lastMetadata = { ...lastMetadata, ...value.metadata }
                  const current = yield* initialize
                  for (const item of streamCaptured ? [] : (lastMetadata.transcript ?? [])) {
                    if (!captured.has(item.id)) captured.set(item.id, item)
                  }
                  const details = [
                    "model",
                    "sandbox",
                    "permission_mode",
                    "thread_id",
                    "session_id",
                    "working_directory",
                  ]
                    .filter((key) => typeof lastMetadata[key] === "string")
                    .map((key) => `${key}: ${lastMetadata[key]}`)
                    .join("\n")
                  if (details)
                    captured.set("external-metadata", {
                      id: "external-metadata",
                      kind: "status",
                      title: "Consultation",
                      text: details,
                    })
                  yield* projection!.flush([...captured.values()])
                  yield* ctx.metadata({ ...value, metadata: { ...value.metadata, externalSessionID: current.id } })
                }),
              ),
            )
          const extra = {
            ...ctx.extra,
            externalTranscript: (item: TranscriptItem) => {
              streamCaptured = true
              captured.set(item.id, { ...captured.get(item.id), ...item })
            },
          }
          log.info(`execute parent=${parent.id} call=${part.callID} advisor=${advisors[tool.id]}`)
          return yield* tool.execute(args, { ...ctx, abort: controller.signal, metadata, extra }).pipe(
            Effect.flatMap((result) =>
              Effect.gen(function* () {
                const current = yield* initialize
                closed = true
                for (const item of streamCaptured ? [] : (result.metadata.transcript ?? []))
                  if (!captured.has(item.id)) captured.set(item.id, item)
                if (![...captured.values()].some((item) => item.kind === "message")) {
                  captured.set("final", {
                    id: "final",
                    kind: "message",
                    text: String(result.metadata.preview ?? result.output).replace(
                      /^<\w+_consult>[\s\S]*?<\/\w+_consult>\s*/,
                      "",
                    ),
                    status: "completed",
                  })
                }
                yield* projection!.flush([...captured.values()], true)
                const messages = yield* sessions.messages({ sessionID: current.id }).pipe(Effect.orDie)
                log.info(`handoff read child=${current.id} parent=${parent.id} messages=${messages.length}`)
                const history = externalConversationOutput({
                  advisor: current.external!.advisor,
                  sessionID: current.id,
                  messages,
                  output: result.output,
                  userIntervened: active.get(key)?.intervened,
                  transcriptAvailable: canReadTranscript ? yield* canReadTranscript(ctx, parent) : true,
                })
                log.info(
                  `handoff assembled child=${current.id} version=${history.handoff.version} turns=${history.turns} intervened=${history.handoff.user_intervened} delivery=${history.handoff.delivery} readBeforeSummary=${history.handoff.read_before_summary} chars=${history.output.length}`,
                )
                const normalized = normalizeOutput
                  ? yield* normalizeOutput(history.output, ctx)
                  : { content: history.output, truncated: false as const }
                const metadata: Record<string, unknown> = {
                  ...result.metadata,
                  externalSessionID: current.id,
                  interventionTurns: history.turns,
                  task_id: current.id,
                  externalHandoff: history.handoff,
                  truncated:
                    normalized.truncated || (!history.handoff.user_intervened && result.metadata.truncated === true),
                }
                if (normalized.truncated) metadata.outputPath = normalized.outputPath
                else if (history.handoff.user_intervened || result.metadata.truncated !== true)
                  delete metadata.outputPath
                log.info(
                  `handoff ready child=${current.id} turns=${history.turns} truncated=${normalized.truncated} chars=${normalized.content.length}`,
                )
                return { ...result, output: normalized.content, metadata }
              }),
            ),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                closed = true
                active.delete(key)
                ctx.abort.removeEventListener("abort", abort)
                closeAdvisorIntervention({ sessionID: parent.id, callID: part.callID })
                if (exit._tag === "Failure" && projection) {
                  const error = controller.signal.aborted ? "External consultation stopped" : Cause.pretty(exit.cause)
                  yield* projection.flush([...captured.values()], true, error)
                  log.warn(`failed child=${child?.id} stopped=${controller.signal.aborted} error=${error}`)
                }
                log.info(`closed child=${child?.id ?? "none"} call=${part.callID}`)
              }),
            ),
          )
        }).pipe(Effect.orDie),
    }
  }

  const importHistory = (parent: Session.Info, messageID: MessageID, partID: PartID) =>
    importLock.withPermit(
      Effect.gen(function* () {
        const source = yield* MessageV2.get({ sessionID: parent.id, messageID })
        const part = source.parts.find((part): part is MessageV2.ToolPart => part.id === partID && part.type === "tool")
        if (!part || !advisors[part.tool]) throw new Error("Not an external CLI consultation")
        const existing = yield* sessions.get(externalSessionID(parent.id, partID)).pipe(Effect.option)
        if (Option.isSome(existing)) return existing.value
        if (
          (part.state.status === "running" || part.state.status === "pending") &&
          (yield* statuses.get(parent.id)).type !== "idle"
        ) {
          throw new Error("External consultation is starting; retry when its child session is ready")
        }
        const child = yield* ensure(parent, source, part, true)
        const metadata = part.state.status === "pending" ? {} : (part.state.metadata ?? {})
        const transcript: TranscriptItem[] = Array.isArray(metadata.transcript) ? [...metadata.transcript] : []
        transcript.unshift({
          id: "history-warning",
          kind: "status",
          title: "Imported history",
          text: "Only the retained external transcript is available. Older entries or long output may have been truncated. This imported consultation is read-only.",
        })
        if (!transcript.some((item) => item.kind === "message")) {
          const output = part.state.status === "completed" ? part.state.output : ""
          const text = String(metadata.preview ?? output).replace(/^<\w+_consult>[\s\S]*?<\/\w+_consult>\s*/, "")
          if (text) transcript.push({ id: "final", kind: "message", text })
        }
        yield* project(
          child,
          source,
          String(part.state.input.prompt ?? ""),
          typeof metadata.model === "string" ? metadata.model : undefined,
        )
          .flush(transcript, true, part.state.status === "error" ? part.state.error : undefined)
          .pipe(
            Effect.onExit((exit) =>
              exit._tag === "Failure" ? sessions.remove(child.id).pipe(Effect.ignore) : Effect.void,
            ),
          )
        log.info(`imported parent=${parent.id} child=${child.id} items=${transcript.length}`)
        return child
      }),
    )

  const control = (
    child: Session.Info,
    action: "status" | "start" | "message" | "finish" | "stop",
    message?: string,
    requestID?: string,
  ) =>
    Effect.gen(function* () {
      if (!child.external || !child.parentID) throw new Error("Not an external child session")
      const directory = yield* InstanceState.directory
      const entry = active.get(`${pathIdentityKey(directory)}:${child.id}`)
      const input = { sessionID: child.parentID, callID: child.external.callID }
      if (action !== "status") {
        if (!entry || child.external.historical) {
          log.warn(
            `control rejected child=${child.id} action=${action} historical=${child.external.historical} available=${!!entry}`,
          )
          throw new Error("External consultation is no longer controllable")
        }
        const accepted =
          action === "stop"
            ? (entry.abort.abort(), true)
            : action === "start"
              ? startAdvisorIntervention(input)
              : action === "finish"
                ? finishAdvisorIntervention(input)
                : sendAdvisorIntervention({ ...input, message: message ?? "", requestID })
        if (!accepted) throw new Error("External consultation rejected the operation")
        if (action === "start") entry.intervened = true
        log.info(`control child=${child.id} action=${action} accepted=${accepted}`)
      }
      const current = entry && advisorInterventionSnapshot(input)
      const ownerPID = child.external.ownerPID
      let ownerAlive = ownerPID !== undefined && ownerPID !== process.pid
      if (ownerAlive) {
        try {
          process.kill(ownerPID!, 0)
        } catch (error) {
          // EPERM means another live process owns it; never finalize that process's work.
          ownerAlive = (error as NodeJS.ErrnoException).code !== "ESRCH"
        }
      }
      if (!entry && !child.external.historical && ownerPID !== undefined && !ownerAlive) {
        yield* sessions.finalizeOrphanedAssistant(child.id, { abortSource: "orphan-finalizer" })
      }
      return {
        available: !!entry && !child.external.historical && !entry.abort.signal.aborted,
        active: current?.active ?? false,
        busy: current?.busy ?? false,
        queued: current?.queued ?? false,
        waitingForInput: current?.waitingForInput ?? false,
        stopping: entry?.abort.signal.aborted ?? false,
      } satisfies ExternalSessionState
    })
  return { wrap, importHistory, control }
}
