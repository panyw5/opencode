import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { Pty } from "@/pty"
import { PtyID } from "@/pty/schema"
import { Shell } from "@/shell/shell"
import { SessionID, MessageID } from "@/session/schema"
import { Deferred, Effect, Layer, Context, Schema, Scope, Stream, Types } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import * as Log from "@opencode-ai/core/util/log"
import path from "path"

const log = Log.create({ service: "background-shell" })
const OUTPUT_LIMIT = 30_000

export const Status = Schema.Literals(["running", "completed", "error", "stopped"])
export type Status = Schema.Schema.Type<typeof Status>

export const Info = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  callID: Schema.optional(Schema.String),
  ptyID: PtyID,
  command: Schema.String,
  cwd: Schema.String,
  description: Schema.optional(Schema.String),
  background: Schema.Boolean,
  status: Status,
  exitCode: Schema.optional(NonNegativeInt),
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  outputTail: Schema.optional(Schema.String),
}).annotate({ identifier: "BackgroundShell" })

export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const CreateInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  callID: Schema.optional(Schema.String),
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  background: Schema.optional(Schema.Boolean),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const ListQuery = Schema.Struct({
  sessionID: Schema.optional(SessionID),
})

export const Params = Schema.Struct({
  id: Schema.String,
})

export const Event = {
  Created: BusEvent.define("background.shell.created", Schema.Struct({ info: Info })),
  Updated: BusEvent.define("background.shell.updated", Schema.Struct({ info: Info })),
  Exited: BusEvent.define("background.shell.exited", Schema.Struct({ info: Info })),
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
}

type State = {
  shells: Map<string, Active>
  subscribed: boolean
}

export type WaitResult = {
  info?: Info
  backgrounded: boolean
}

export interface Interface {
  readonly list: (input?: { sessionID?: SessionID }) => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly setBackground: (id: string) => Effect.Effect<Info | undefined>
  readonly wait: (id: string) => Effect.Effect<WaitResult>
  readonly stop: (id: string) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundShell") {}

function tail(text: string | undefined) {
  if (!text) return undefined
  if (Buffer.byteLength(text, "utf-8") <= OUTPUT_LIMIT) return text
  const buf = Buffer.from(text, "utf-8")
  let start = buf.length - OUTPUT_LIMIT
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start).toString("utf-8")
}

function copy(info: Info): Info {
  return { ...info }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const pty = yield* Pty.Service
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make<State>(
      Effect.fn("BackgroundShell.state")(function* () {
        return { shells: new Map(), subscribed: false }
      }),
    )

    const refresh = Effect.fn("BackgroundShell.refresh")(function* (active: Active) {
      const info = active.info
      if (info.status !== "running") return info
      const snap = yield* pty.snapshot(info.ptyID).pipe(Effect.option)
      if (snap._tag === "None") return info
      const next = {
        ...info,
        outputTail: tail(snap.value.output),
      }
      active.info = next
      return next
    })

    const publishUpdate = Effect.fn("BackgroundShell.publishUpdate")(function* (active: Active) {
      const info = copy(active.info)
      yield* bus.publish(Event.Updated, { info })
      if (info.status !== "running") yield* bus.publish(Event.Exited, { info })
    })

    const onPtyExited = Effect.fn("BackgroundShell.onPtyExited")(function* (event: {
      properties: Schema.Schema.Type<(typeof Pty.Event.Exited)["properties"]>
    }) {
      const s = yield* InstanceState.get(state)
      const match = Array.from(s.shells.values()).find((item) => item.info.ptyID === event.properties.id)
      if (!match || match.info.status !== "running") return
      const next = {
        ...match.info,
        status: event.properties.exitCode === 0 ? ("completed" as const) : ("error" as const),
        exitCode: event.properties.exitCode,
        endedAt: Date.now(),
        outputTail: tail(event.properties.output),
      }
      log.info("background shell exited", { id: next.id, exitCode: next.exitCode })
      match.info = next
      yield* Deferred.succeed(match.done, copy(next)).pipe(Effect.ignore)
      yield* publishUpdate(match)
    })

    const ensureSubscribed = Effect.fn("BackgroundShell.ensureSubscribed")(function* () {
      const s = yield* InstanceState.get(state)
      if (s.subscribed) return
      s.subscribed = true
      const stream = yield* Scope.provide(scope)(bus.subscribe(Pty.Event.Exited))
      yield* Stream.runForEach(stream, onPtyExited).pipe(Effect.ignore, Effect.forkIn(scope))
    })

    const list: Interface["list"] = Effect.fn("BackgroundShell.list")(function* (input) {
      yield* ensureSubscribed()
      const s = yield* InstanceState.get(state)
      const items = Array.from(s.shells.values()).filter(
        (item) => item.info.background && (!input?.sessionID || item.info.sessionID === input.sessionID),
      )
      return yield* Effect.forEach(items, (item) => refresh(item).pipe(Effect.map(copy)), {
        concurrency: "unbounded",
      }).pipe(Effect.map((items) => items.toSorted((a, b) => a.startedAt - b.startedAt)))
    })

    const get: Interface["get"] = Effect.fn("BackgroundShell.get")(function* (id) {
      yield* ensureSubscribed()
      const active = (yield* InstanceState.get(state)).shells.get(id)
      if (!active) return
      return copy(yield* refresh(active))
    })

    const create: Interface["create"] = Effect.fn("BackgroundShell.create")(function* (input) {
      yield* ensureSubscribed()
      const ctx = yield* InstanceState.context
      const cfg = yield* config.get()
      const sh = Shell.acceptable(cfg.shell)
      const cwd = input.cwd
        ? path.isAbsolute(input.cwd)
          ? input.cwd
          : path.resolve(ctx.directory, input.cwd)
        : ctx.directory
      const info = yield* pty.create({
        command: sh,
        args: Shell.args(sh, input.command, cwd),
        cwd,
        title: input.description ?? input.command,
        env: input.env ? { ...input.env } : undefined,
      })
      const shell: Info = {
        id: Identifier.ascending("job"),
        sessionID: input.sessionID,
        ...(input.messageID ? { messageID: input.messageID } : {}),
        ...(input.callID ? { callID: input.callID } : {}),
        ptyID: info.id,
        command: input.command,
        cwd,
        ...(input.description ? { description: input.description } : {}),
        background: input.background === true,
        status: "running",
        startedAt: Date.now(),
      }
      const active: Active = {
        info: shell,
        done: yield* Deferred.make<Info>(),
        backgrounded: yield* Deferred.make<Info>(),
      }
      ;(yield* InstanceState.get(state)).shells.set(shell.id, active)
      yield* bus.publish(Event.Created, { info: copy(shell) })
      return copy(shell)
    })

    const setBackground: Interface["setBackground"] = Effect.fn("BackgroundShell.setBackground")(function* (id) {
      yield* ensureSubscribed()
      const active = (yield* InstanceState.get(state)).shells.get(id)
      if (!active) return
      if (active.info.background || active.info.status !== "running") return copy(active.info)
      const snap = yield* pty.snapshot(active.info.ptyID).pipe(Effect.option)
      const output = snap._tag === "Some" ? snap.value.output : active.info.outputTail
      active.info = {
        ...active.info,
        background: true,
        outputTail: tail(output),
      }
      yield* Deferred.succeed(active.backgrounded, copy(active.info)).pipe(Effect.ignore)
      yield* publishUpdate(active)
      return copy(active.info)
    })

    const wait: Interface["wait"] = Effect.fn("BackgroundShell.wait")(function* (id) {
      yield* ensureSubscribed()
      const active = (yield* InstanceState.get(state)).shells.get(id)
      if (!active) return { backgrounded: false }
      if (active.info.status !== "running") return { info: copy(active.info), backgrounded: false }
      if (active.info.background) return { info: copy(active.info), backgrounded: true }
      return yield* Effect.race(
        Deferred.await(active.done).pipe(Effect.map((info) => ({ info: copy(info), backgrounded: false }))),
        Deferred.await(active.backgrounded).pipe(Effect.map((info) => ({ info: copy(info), backgrounded: true }))),
      )
    })

    const stop: Interface["stop"] = Effect.fn("BackgroundShell.stop")(function* (id) {
      yield* ensureSubscribed()
      const s = yield* InstanceState.get(state)
      const active = s.shells.get(id)
      if (!active) return
      if (active.info.status === "running") {
        yield* pty.remove(active.info.ptyID).pipe(Effect.ignore)
        const next = {
          ...active.info,
          status: "stopped" as const,
          endedAt: Date.now(),
        }
        active.info = next
        yield* Deferred.succeed(active.done, copy(next)).pipe(Effect.ignore)
        yield* publishUpdate(active)
        return copy(next)
      }
      return copy(active.info)
    })

    return Service.of({ list, get, create, setBackground, wait, stop })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Pty.defaultLayer),
)

export * as BackgroundShell from "./shell"
