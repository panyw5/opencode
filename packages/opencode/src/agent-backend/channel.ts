import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Semaphore } from "effect"
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk"
import * as Log from "@opencode-ai/core/util/log"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { ModelID, ProviderID } from "@/provider/schema"
import type { SessionChannel as SessionChannelInfo } from "@/session/channel-schema"
import { ConsultMentions } from "@/session/consult-mentions"
import type { Advisor } from "@/session/external-schema"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { makeTranscriptProjector } from "@/session/transcript-projector"
import { isConsultMention } from "@/tool/consult-mention"
import { ToolRegistry } from "@/tool/registry"
import type { PromptInput } from "@/session/prompt"
import { AcpAgentClient, AcpAuthenticationRequired } from "./acp-client"
import { AcpTranscript } from "./acp-transcript"
import { managedAgents } from "./install"
import { acpMcpServers, type McpConfig } from "./mcp-servers"
import type { AcpConfig } from "./schema"

const log = Log.create({ service: "agent-backend.channel" })

const DEFAULT_IDLE_MS = 10 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_PROCESSES = 4
const PROJECTION_THROTTLE_MS = 120

type Projector = ReturnType<typeof makeTranscriptProjector>

type Entry = {
  advisor: Advisor
  client: AcpAgentClient
  semaphore: Semaphore.Semaphore
  permissionPolicy: "deny" | "ask"
  ruleset: Permission.Ruleset
  live?: AcpTranscript
  projector?: Projector
  bridge?: EffectBridge.Shape
  publishing: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  abort?: AbortController
  release?: () => Promise<void>
  busy: boolean
  lastUsed: number
}

type State = { entries: Map<string, Entry> }

export interface Interface {
  readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly update: (input: { sessionID: SessionID; model?: string; mode?: string }) => Effect.Effect<void>
  readonly dispose: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionChannel") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const registry = yield* ToolRegistry.Service
    const config = yield* Config.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("SessionChannel.state")(function* () {
        const current: State = { entries: new Map() }
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            for (const entry of current.entries.values()) {
              entry.abort?.abort()
              if (entry.timer) clearTimeout(entry.timer)
              await entry.client.stop().catch(() => {})
              await entry.release?.().catch(() => {})
            }
            current.entries.clear()
          }),
        )
        return current
      }),
    )

    const stopEntry = (entry: Entry) =>
      Effect.gen(function* () {
        entry.abort?.abort()
        if (entry.timer) clearTimeout(entry.timer)
        yield* Effect.promise(() => entry.client.stop().catch(() => {}))
        if (entry.release) yield* Effect.promise(() => entry.release!().catch(() => {}))
      })

    const reap = (current: State, info: Config.Info) =>
      Effect.gen(function* () {
        const idle = info.agent_channels?.idle_timeout_ms ?? DEFAULT_IDLE_MS
        const now = Date.now()
        for (const [id, entry] of current.entries) {
          if (entry.busy || now - entry.lastUsed < idle) continue
          log.info(`reap session=${id} advisor=${entry.advisor} idleMs=${now - entry.lastUsed}`)
          current.entries.delete(id)
          yield* stopEntry(entry)
        }
      })

    const enforceLimit = (current: State, keep: string, info: Config.Info) =>
      Effect.gen(function* () {
        const max = info.agent_channels?.max_processes ?? DEFAULT_MAX_PROCESSES
        while (current.entries.size > max) {
          const victim = [...current.entries.entries()]
            .filter(([id, entry]) => id !== keep && !entry.busy)
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
          if (!victim) break
          log.warn(`evict session=${victim[0]} advisor=${victim[1].advisor} size=${current.entries.size} max=${max}`)
          current.entries.delete(victim[0])
          yield* stopEntry(victim[1])
        }
      })

    const requestPermission =
      (entry: Entry, sessionID: SessionID) =>
      async (request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> => {
        const cancelled = { outcome: { outcome: "cancelled" as const } }
        if (signal.aborted) return cancelled
        const reject = request.options.find((item) => item.kind === "reject_once")
        const deny = () =>
          reject ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } } : cancelled
        const allow = request.options.find((item) => item.kind === "allow_once")
        const bridge = entry.bridge
        if (entry.permissionPolicy !== "ask" || !allow || !bridge) return deny()
        log.info(
          `permission session=${sessionID} advisor=${entry.advisor} tool=${request.toolCall.toolCallId} policy=${entry.permissionPolicy}`,
        )
        const fiber = bridge.fork(
          permission.ask({
            sessionID,
            permission: "external_agent_tool",
            patterns: request.toolCall.locations?.length
              ? request.toolCall.locations.map((item) => item.path)
              : [request.toolCall.toolCallId],
            always: [],
            metadata: { advisor: entry.advisor, backend: "acp", toolCall: request.toolCall },
            ruleset: entry.ruleset,
          }),
        )
        const abort = () => {
          bridge.fork(Fiber.interrupt(fiber))
        }
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
        try {
          await bridge.promise(Fiber.join(fiber))
        } catch (error) {
          log.info(`permission rejected session=${sessionID} advisor=${entry.advisor} error=${String(error)}`)
          return deny()
        } finally {
          signal.removeEventListener("abort", abort)
        }
        return signal.aborted ? cancelled : { outcome: { outcome: "selected", optionId: allow.optionId } }
      }

    const ensure = Effect.fn("SessionChannel.ensure")(function* (
      current: State,
      session: Session.Info,
      channel: SessionChannelInfo,
      info: Config.Info,
    ) {
      const existing = current.entries.get(session.id)
      if (existing?.client.alive) return existing
      if (existing) {
        log.warn(`replacing dead channel session=${session.id} advisor=${existing.advisor}`)
        current.entries.delete(session.id)
        yield* stopEntry(existing)
      }

      const selection = info.agent_backends?.[channel.advisor]
      if (!selection || selection.type !== "acp")
        throw new Error(`${channel.advisor} is not configured for ACP; select a different channel or configure agent_backends`)
      const managed = selection.managed
      if (managed && managed.advisor !== channel.advisor)
        throw new Error("Managed adapter does not match the selected channel advisor")
      const lease = managed
        ? yield* Effect.promise(() => managedAgents().acquire(managed.advisor, managed.version))
        : undefined
      const command = lease ? (lease.command as [string, ...string[]]) : selection.command
      const acpConfig: AcpConfig = {
        ...selection,
        command,
        ...(channel.mode ? { mode: channel.mode } : {}),
      }

      let entry: Entry | undefined
      const holder: { entry?: Entry } = {}
      const client = new AcpAgentClient({
        config: acpConfig,
        cwd: session.directory,
        model: channel.model ?? selection.model,
        keepAlive: true,
        mcpServers: (capabilities) =>
          acpMcpServers({
            servers: info.mcp as McpConfig | undefined,
            allow: info.agent_channels?.mcp,
            capabilities,
          }),
        onEvent: (event) => {
          const target = holder.entry
          if (!target) return
          target.live?.apply(event)
          const projector = target.projector
          const bridge = target.bridge
          if (!projector || !bridge || target.timer) return
          target.timer = setTimeout(() => {
            target.timer = undefined
            const active = target.projector
            if (!active) return
            target.publishing = target.publishing
              .then(() => bridge.promise(active.apply(target.live?.transcript ?? [])))
              .catch((error) => log.warn(`projection failed session=${session.id} error=${String(error)}`))
          }, PROJECTION_THROTTLE_MS)
        },
        requestPermission: (request, signal) => {
          const target = holder.entry
          if (!target) return Promise.resolve({ outcome: { outcome: "cancelled" as const } })
          return requestPermission(target, session.id)(request, signal)
        },
      })

      entry = {
        advisor: channel.advisor,
        client,
        semaphore: Semaphore.makeUnsafe(1),
        permissionPolicy: selection.permission ?? "deny",
        ruleset: session.permission ? [...session.permission] : [],
        publishing: Promise.resolve(),
        busy: false,
        lastUsed: Date.now(),
        release: lease ? () => lease.release() : undefined,
      }
      holder.entry = entry
      current.entries.set(session.id, entry)
      log.info(
        `spawn session=${session.id} advisor=${channel.advisor} cwd=${session.directory} managed=${Boolean(managed)} resume=${channel.acpSessionID ?? "none"}`,
      )

      const started = Date.now()
      const result = yield* Effect.exit(
        Effect.promise(() => client.start(new AbortController().signal, { resumeSessionID: channel.acpSessionID })),
      )
      if (Exit.isFailure(result)) {
        current.entries.delete(session.id)
        yield* stopEntry(entry)
        const error = Cause.squash(result.cause)
        if (error instanceof AcpAuthenticationRequired)
          throw new Error(
            `Authentication is required for ${channel.advisor}. Complete it on the backend machine, then retry.`,
          )
        throw error instanceof Error ? error : new Error(String(error))
      }
      log.info(
        `ready session=${session.id} advisor=${channel.advisor} acpSession=${client.sessionID ?? "none"} ms=${Date.now() - started}`,
      )
      if (client.sessionID && client.sessionID !== channel.acpSessionID) {
        yield* sessions.setChannel({
          sessionID: session.id,
          channel: { ...channel, acpSessionID: client.sessionID },
        })
      }
      yield* enforceLimit(current, session.id, info)
      return entry
    })

    const runTurn = Effect.fn("SessionChannel.runTurn")(function* (
      entry: Entry,
      session: Session.Info,
      info: Config.Info,
      input: PromptInput,
    ) {
      const channel = session.channel!
      entry.busy = true
      entry.lastUsed = Date.now()
      entry.ruleset = session.permission ? [...session.permission] : []
      const bridge = yield* EffectBridge.make()
      entry.bridge = bridge
      const abort = new AbortController()
      entry.abort = abort
      const started = Date.now()

      const text = promptText(input.parts)
      const userID = input.messageID ?? MessageID.ascending()
      const modelID = ModelID.make(channel.model ?? entry.client.model ?? "default")
      const providerID = ProviderID.make(`external-${channel.advisor}`)
      const model = { providerID, modelID }
      const user: MessageV2.User = {
        id: userID,
        sessionID: session.id,
        role: "user",
        agent: channel.advisor,
        model,
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(user)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: userID,
        type: "text",
        text,
      })
      yield* status.set(session.id, { type: "busy" })

      if (input.noReply) {
        const found = yield* sessions.findMessage(session.id, (msg) => msg.info.id === userID).pipe(Effect.orDie)
        return Option.getOrElse(found, () => ({ info: user, parts: [] }))
      }

      const names = [
        ...new Set(
          input.parts.flatMap((part) =>
            part.type === "agent" && isConsultMention(part.name) ? [part.name] : [],
          ),
        ),
      ]
      const others = names.filter((name) => name !== channel.advisor)
      let context = ""
      if (others.length) {
        const result = yield* ConsultMentions.runConsultMentions(
          { sessions, registry, permission, plugin, directory: session.directory, worktree: session.directory },
          {
            session,
            lastUser: user,
            msgs: yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie),
            lastUserParts: input.parts as unknown as MessageV2.Part[],
            names: others,
            agent: { name: channel.advisor, permission: session.permission ?? [] },
            model: { id: modelID, providerID },
            mode: "channel",
          },
        )
        context = consultContext(result)
      }
      if (names.includes(channel.advisor)) {
        context = [
          context,
          `This session already runs on ${channel.advisor}; the @${channel.advisor} mention was not executed as a separate consultation.`,
        ]
          .filter(Boolean)
          .join("\n\n")
      }

      const live = new AcpTranscript()
      live.beginTurn(text)
      entry.live = live
      const projector = makeTranscriptProjector({
        sessions,
        statuses: status,
        session,
        agent: channel.advisor,
        model,
        initialText: "",
        initialMessageID: userID,
        writeInitialUser: false,
        userItems: "ignore",
        finalIdle: true,
      })
      entry.projector = projector

      const prompt = [text || "Continue.", context].filter(Boolean).join("\n\n")
      const timeout = info.agent_channels?.timeout_ms ?? DEFAULT_TIMEOUT_MS
      log.info(
        `prompt session=${session.id} advisor=${channel.advisor} chars=${prompt.length} consults=${others.length} model=${modelID}`,
      )
      const outcome = yield* Effect.exit(
        Effect.promise(() => entry.client.prompt(prompt, abort.signal, timeout)),
      )

      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
      yield* Effect.promise(() => entry.publishing)

      let failure: string | undefined
      if (Exit.isFailure(outcome) && !abort.signal.aborted) {
        const error = Cause.squash(outcome.cause)
        failure = error instanceof Error ? error.message : String(error)
        log.warn(`turn failed session=${session.id} advisor=${channel.advisor} error=${failure}`)
      } else if (Exit.isSuccess(outcome)) {
        const reason = outcome.value.stopReason
        if (reason !== "end_turn" && reason !== "cancelled") failure = `ACP turn stopped: ${reason}`
        log.info(`turn finished session=${session.id} advisor=${channel.advisor} reason=${reason} ms=${Date.now() - started}`)
      } else {
        log.info(`turn cancelled session=${session.id} advisor=${channel.advisor} ms=${Date.now() - started}`)
      }

      yield* projector.apply(live.transcript, true, failure)
      if (failure) throw new Error(failure)

      const found = yield* sessions
        .findMessage(session.id, (msg) => msg.info.role === "assistant" && msg.info.parentID === userID)
        .pipe(Effect.orDie)
      return Option.getOrElse(found, () => ({ info: user, parts: [] }))
    })

    const prompt = Effect.fn("SessionChannel.prompt")(function* (input: PromptInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      const channel = session.channel
      if (!channel) throw new Error("Session is not bound to an external channel")
      if (session.external) throw new Error("External CLI sessions cannot use a channel")
      if (session.time.archived) throw new Error("Session is archived")
      const info = yield* config.get()
      const current = yield* InstanceState.get(state)
      yield* reap(current, info)
      const entry = yield* ensure(current, session, channel, info)
      return yield* entry.semaphore.withPermit(
        runTurn(entry, session, info, input).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              entry.busy = false
              entry.abort = undefined
              entry.bridge = undefined
              entry.live = undefined
              entry.projector = undefined
              entry.lastUsed = Date.now()
              if (entry.timer) {
                clearTimeout(entry.timer)
                entry.timer = undefined
              }
              yield* status.set(session.id, { type: "idle" })
            }),
          ),
        ),
      )
    })

    const cancel = Effect.fn("SessionChannel.cancel")(function* (sessionID: SessionID) {
      const current = yield* InstanceState.get(state)
      const entry = current.entries.get(sessionID)
      if (!entry) return
      log.info(`cancel session=${sessionID} advisor=${entry.advisor}`)
      entry.abort?.abort()
      yield* Effect.promise(() => entry.client.cancel().catch(() => {}))
    })

    const update = Effect.fn("SessionChannel.update")(function* (input: {
      sessionID: SessionID
      model?: string
      mode?: string
    }) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.channel) throw new Error("Session is not bound to an external channel")
      const next: SessionChannelInfo = {
        ...session.channel,
        ...(input.model ? { model: input.model } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      }
      yield* sessions.setChannel({ sessionID: input.sessionID, channel: next })
      const current = yield* InstanceState.get(state)
      const entry = current.entries.get(input.sessionID)
      if (!entry) return
      if (input.model) yield* Effect.promise(() => entry.client.setModel(input.model!))
      if (input.mode) yield* Effect.promise(() => entry.client.setMode(input.mode!))
    })

    const dispose = Effect.fn("SessionChannel.dispose")(function* (sessionID: SessionID) {
      const current = yield* InstanceState.get(state)
      const entry = current.entries.get(sessionID)
      if (!entry) return
      log.info(`dispose session=${sessionID} advisor=${entry.advisor}`)
      current.entries.delete(sessionID)
      yield* stopEntry(entry)
    })

    return Service.of({ prompt, cancel, update, dispose })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Permission.defaultLayer),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(ToolRegistry.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

function promptText(parts: PromptInput["parts"]) {
  const text = parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n")
  const files = parts
    .flatMap((part) => (part.type === "file" ? [part.filename] : []))
    .filter((value): value is string => Boolean(value))
  const references = files.length ? ["Referenced files:", ...files.map((file) => `- ${file}`)].join("\n") : ""
  return [text, references].filter(Boolean).join("\n\n")
}

function consultContext(result: ConsultMentions.Result) {
  if (!result.names.length) return ""
  const blocks = result.outcomes.map((outcome) =>
    outcome.returned && outcome.output
      ? `<consultation advisor="${outcome.name}">\n${outcome.output}\n</consultation>`
      : `<consultation advisor="${outcome.name}" status="failed">${outcome.error ?? "no result"}</consultation>`,
  )
  return [...blocks, result.summary].filter(Boolean).join("\n\n")
}

export * as SessionChannel from "./channel"
