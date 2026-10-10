import * as Log from "@opencode-ai/core/util/log"
import { Bus } from "@/bus"
import type { InstanceContext } from "@/project/instance-context"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import type { Duration } from "effect"
import { Updated as BrowserUpdated, Closed as BrowserClosed, GptProNotificationReceived } from "./events"

export * as BrowserBridge from "./bridge"

const log = Log.create({ service: "browser-bridge" })

const COMMAND_TIMEOUT_DEFAULT = "30 seconds"
const CONSOLE_BUFFER_LIMIT = 500

// Frames are plain JSON text in both directions.
// server -> desktop: { type: "cmd", id, name, args }
// desktop -> server: { type: "hello", client, version, views }
//                    { type: "resp", id, ok, result?, error? }
//                    { type: "event", name, properties }

export type Adapter = {
  readonly send: (data: string) => void
  readonly close: (code?: number, reason?: string) => void
}

export type ClientInfo = {
  readonly kind: string
  readonly version: string
}

export const ViewState = Schema.Struct({
  pageID: Schema.optional(Schema.String),
  profileID: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.Struct({ directory: Schema.optional(Schema.String), sessionID: Schema.optional(Schema.String) })),
  kind: Schema.optional(Schema.Literals(["user", "agent", "consultation", "login"])),
  partition: Schema.String,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  shared: Schema.Boolean,
  // Optional on the wire for tolerance against older desktop clients.
  epoch: Schema.optional(Schema.Number),
})
export type ViewState = typeof ViewState.Type

export const ConsoleEntry = Schema.Struct({
  pageID: Schema.optional(Schema.String),
  profileID: Schema.optional(Schema.String),
  partition: Schema.String,
  level: Schema.Literals(["log", "info", "warn", "error"]),
  text: Schema.String,
  at: Schema.Number,
})
export type ConsoleEntry = typeof ConsoleEntry.Type

type Pending = {
  readonly deferred: Deferred.Deferred<unknown, CommandError>
}

export type State =
  | { readonly status: "absent" }
  | { readonly status: "connected"; readonly client?: ClientInfo; readonly views: readonly ViewState[] }

export class AbsentError extends Schema.TaggedErrorClass<AbsentError>()("BrowserBridge.AbsentError", {
  message: Schema.optional(Schema.String),
}) {}

export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("BrowserBridge.TimeoutError", {
  message: Schema.optional(Schema.String),
}) {}

export class CommandFailedError extends Schema.TaggedErrorClass<CommandFailedError>()(
  "BrowserBridge.CommandFailedError",
  {
    message: Schema.String,
  },
) {}

export type CommandError = AbsentError | TimeoutError | CommandFailedError

export interface Interface {
  /** Register the desktop client. Replaces any previous connection. */
  readonly connect: (input: {
    readonly adapter: Adapter
    readonly client?: ClientInfo
    readonly views?: readonly ViewState[]
    readonly instance?: InstanceContext
  }) => Effect.Effect<void>
  readonly disconnect: () => Effect.Effect<void>
  readonly state: () => Effect.Effect<State>
  /** Send a command to the connected desktop client and await its response. */
  readonly command: <T = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: { readonly timeout?: Duration.Input },
  ) => Effect.Effect<T, CommandError>
  /** Feed one raw text frame coming from the desktop client. */
  readonly handleFrame: (text: string) => Effect.Effect<void>
  /** Buffered console entries captured from `browser.console` event frames. */
  readonly console: (pageID: string, since?: number) => Effect.Effect<ConsoleEntry[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BrowserBridge") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let adapter: Adapter | undefined
    let client: ClientInfo | undefined
    let instance: InstanceContext | undefined
    let views: readonly ViewState[] = []
    const closedEpochs = new Map<string, number>()
    const pending = new Map<string, Pending>()
    const consoleBuffer: ConsoleEntry[] = []

    const normalizeView = (view: ViewState) =>
      view.pageID === undefined ? view : { ...view, partition: view.pageID }

    const failPending = (error: CommandError) => {
      for (const [id, entry] of pending) {
        pending.delete(id)
        void Effect.runPromise(Deferred.fail(entry.deferred, error)).catch(() => {})
      }
    }

    const publishEvent = (name: string, properties: unknown) => {
      // A bad event frame must never kill the bridge connection: the desktop
      // client may be newer/older than this schema. Drop the frame and keep
      // the socket alive (a decode throw here would crash the WS read loop).
      try {
        if (name === "browser.updated") {
          const decoded = Schema.decodeUnknownSync(ViewState)(properties)
          const pageID = decoded.pageID ?? decoded.partition
          const normalized = decoded.pageID === undefined ? decoded : { ...decoded, partition: pageID }
          // Merge by pageID: several independent pages can share one profile.
          // Each desktop event describes one view, so replacing the whole list
          // would collapse the server's view of the browser.
          // Stale events (epoch older than the stored view's) are dropped.
          const closedEpoch = closedEpochs.get(pageID) ?? -1
          if ((normalized.epoch ?? 0) <= closedEpoch) return
          const stored = views.find((view) => (view.pageID ?? view.partition) === pageID)
          if (stored && (normalized.epoch ?? 0) < (stored.epoch ?? 0)) return
          closedEpochs.delete(pageID)
          views = stored
            ? views.map((view) => ((view.pageID ?? view.partition) === pageID ? normalized : view))
            : [...views, normalized]
          if (!instance) return
          void Bus.publish(instance, BrowserUpdated, {
            ...normalized,
          }).catch((cause) => log.error("bus publish failed", { cause: String(cause) }))
          return
        }
        if (name === "browser.closed") {
          const decoded = Schema.decodeUnknownSync(
            Schema.Struct({ pageID: Schema.optional(Schema.String), partition: Schema.String, profileID: Schema.optional(Schema.String), epoch: Schema.optional(Schema.Number) }),
          )(properties)
          const pageID = decoded.pageID ?? decoded.partition
          const current = views.find((view) => (view.pageID ?? view.partition) === pageID)
          const epoch = decoded.epoch ?? 0
          if (current && (current.epoch ?? 0) > epoch) return
          if (epoch <= (closedEpochs.get(pageID) ?? -1)) return
          closedEpochs.set(pageID, epoch)
          views = views.filter((view) => (view.pageID ?? view.partition) !== pageID)
          if (!instance) return
          void Bus.publish(instance, BrowserClosed, {
            pageID,
            partition: pageID,
            profileID: decoded.profileID,
            epoch,
          }).catch((cause) => log.error("bus publish failed", { cause: String(cause) }))
          return
        }
        if (name === "browser.console") {
          const decoded = Schema.decodeUnknownSync(ConsoleEntry)(properties)
          consoleBuffer.push(decoded)
          if (consoleBuffer.length > CONSOLE_BUFFER_LIMIT)
            consoleBuffer.splice(0, consoleBuffer.length - CONSOLE_BUFFER_LIMIT)
          return
        }
        if (name === "gpt-pro.notification") {
          const decoded = Schema.decodeUnknownSync(GptProNotificationReceived.properties)(properties)
          if (!instance) return
          void Bus.publish(instance, GptProNotificationReceived, decoded).catch((cause) =>
            log.error("GPT-Pro notification publish failed", { cause: String(cause) }),
          )
        }
      } catch (cause) {
        log.warn("dropping invalid event frame", { name, cause: String(cause) })
      }
    }

    return Service.of({
      connect: (input) =>
        Effect.sync(() => {
          // A second concurrent connection replaces the first: the desktop app
          // is the only legitimate client, and a reconnect after a lost socket
          // may race with the server noticing the disconnect.
          if (adapter) {
            failPending(new AbsentError({ message: "bridge client replaced" }))
            try {
              adapter.close()
            } catch {
              // previous socket may already be dead
            }
          }
          adapter = input.adapter
          client = input.client
          instance = input.instance
          views = input.views?.map(normalizeView) ?? []
          closedEpochs.clear()
          log.info("client connected", { client: client?.kind, version: client?.version, views: views.length })
        }),

      disconnect: () =>
        Effect.sync(() => {
          if (!adapter) return
          adapter = undefined
          client = undefined
          views = []
          closedEpochs.clear()
          failPending(new AbsentError({ message: "bridge client disconnected" }))
          log.info("client disconnected")
        }),

      state: () =>
        Effect.sync(() => (adapter ? { status: "connected" as const, client, views } : { status: "absent" as const })),

      command: <T>(name: string, args?: Record<string, unknown>, options?: { readonly timeout?: Duration.Input }) =>
        Effect.gen(function* () {
          const current = adapter
          if (!current) return yield* new AbsentError({ message: "browser bridge client not connected" })
          const id = `cmd_${Math.random().toString(36).slice(2)}`
          const deferred = yield* Deferred.make<unknown, CommandError>()
          pending.set(id, { deferred })
          const payload = JSON.stringify({ type: "cmd", id, name, args: args ?? {} })
          try {
            current.send(payload)
          } catch (cause) {
            pending.delete(id)
            log.error("send failed", { name, cause: String(cause) })
            return yield* new CommandFailedError({ message: `failed to send command "${name}": ${String(cause)}` })
          }
          return yield* Deferred.await(deferred).pipe(
            Effect.timeout(options?.timeout ?? COMMAND_TIMEOUT_DEFAULT),
            Effect.ensuring(Effect.sync(() => pending.delete(id))),
            Effect.mapError((cause) =>
              // effect v4: Effect.timeout fails with internal TimeoutError (_tag/name "TimeoutError")
              cause instanceof Error &&
              (cause.name === "TimeoutError" || (cause as { _tag?: string })._tag === "TimeoutError")
                ? new TimeoutError({ message: `command "${name}" timed out` })
                : (cause as CommandError),
            ),
          ) as Effect.Effect<T, CommandError>
        }),
      handleFrame: (text) =>
        Effect.gen(function* () {
          let frame: Record<string, unknown>
          try {
            frame = JSON.parse(text)
          } catch {
            log.warn("dropping malformed frame", { length: text.length })
            return
          }
          if (frame.type === "hello") {
            client = {
              kind: typeof frame.client === "string" ? frame.client : "unknown",
              version: typeof frame.version === "string" ? frame.version : "unknown",
            }
            try {
              views = Schema.decodeUnknownSync(Schema.Array(ViewState))(frame.views ?? []).map(normalizeView)
              closedEpochs.clear()
            } catch (cause) {
              log.warn("dropping invalid hello views", { cause: String(cause) })
              views = []
            }
            log.info("hello", { client: client.kind, version: client.version, views: views.length })
            return
          }
          if (frame.type === "resp") {
            const id = typeof frame.id === "string" ? frame.id : undefined
            if (!id) return
            const entry = pending.get(id)
            if (!entry) {
              log.warn("response for unknown command", { id })
              return
            }
            pending.delete(id)
            if (frame.ok === true) {
              yield* Deferred.succeed(entry.deferred, frame.result)
              return
            }
            const message =
              typeof frame.error === "string"
                ? frame.error
                : `command failed: ${JSON.stringify(frame.error ?? "unknown error")}`
            yield* Deferred.fail(entry.deferred, new CommandFailedError({ message }))
            return
          }
          if (frame.type === "event") {
            const name = typeof frame.name === "string" ? frame.name : undefined
            if (!name) return
            publishEvent(name, frame.properties)
            return
          }
          log.warn("unknown frame type", { type: String(frame.type) })
        }),

      console: (pageID, since) =>
        Effect.sync(() =>
          consoleBuffer.filter(
            (entry) => (entry.pageID ?? entry.partition) === pageID && (since === undefined || entry.at > since),
          ),
        ),
    })
  }),
)

export const defaultLayer = layer
