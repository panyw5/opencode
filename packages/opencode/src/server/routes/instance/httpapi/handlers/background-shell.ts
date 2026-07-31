import { BackgroundShell } from "@/background/shell"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceHttpApi } from "../api"
import { ListQuery } from "../groups/background-shell"

const log = Log.create({ service: "background-shell.http" })

export const backgroundShellHandlers = HttpApiBuilder.group(InstanceHttpApi, "background-shell", (handlers) =>
  Effect.gen(function* () {
    const backgroundShell = yield* BackgroundShell.Service

    const list = Effect.fn("BackgroundShellHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      return yield* backgroundShell.list({ sessionID: ctx.query.sessionID })
    })

    const create = Effect.fn("BackgroundShellHttpApi.create")(function* (ctx: {
      payload: typeof BackgroundShell.CreateInput.Type
    }) {
      return yield* backgroundShell.create({
        ...ctx.payload,
        background: ctx.payload.background ?? true,
        env: ctx.payload.env ? { ...ctx.payload.env } : undefined,
      })
    })

    const stop = Effect.fn("BackgroundShellHttpApi.stop")(function* (ctx: {
      params: typeof BackgroundShell.Params.Type
    }) {
      const stopped = yield* backgroundShell.stop(ctx.params.id)
      return !!stopped
    })

    const background = Effect.fn("BackgroundShellHttpApi.background")(function* (ctx: {
      params: typeof BackgroundShell.Params.Type
    }) {
      log.info("background request", { id: ctx.params.id })
      const info = yield* backgroundShell.setBackground(ctx.params.id)
      if (!info) {
        log.warn("background shell not found", { id: ctx.params.id })
        return yield* new HttpApiError.NotFound({})
      }
      log.info("background request completed", {
        id: info.id,
        sessionID: info.sessionID,
        status: info.status,
        background: info.background,
      })
      return info
    })

    return handlers.handle("list", list).handle("create", create).handle("background", background).handle("stop", stop)
  }),
)
