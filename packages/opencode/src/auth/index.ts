import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Flock } from "@opencode-ai/core/util/flock"
import * as Log from "@opencode-ai/core/util/log"
import { randomUUID } from "node:crypto"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")
const log = Log.create({ service: "auth" })

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const persist = (data: Record<string, Info>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => `${file}.${randomUUID()}.tmp`),
        (temporary) =>
          fsys
            .writeFileString(temporary, JSON.stringify(data, null, 2), { mode: 0o600 })
            .pipe(Effect.andThen(fsys.rename(temporary, file)), Effect.mapError(fail("Failed to write auth data"))),
        (temporary) => fsys.remove(temporary, { force: true }).pipe(Effect.ignore),
      )

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      yield* Flock.effect(`auth-file:${file}`)
      const norm = key.replace(/\/+$/, "")
      log.info("updating credential under file lock", { provider: norm })
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* persist({ ...data, [norm]: info })
    }, Effect.scoped)

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      yield* Flock.effect(`auth-file:${file}`)
      const norm = key.replace(/\/+$/, "")
      log.info("removing credential under file lock", { provider: norm })
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* persist(data)
    }, Effect.scoped)

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Auth from "."
