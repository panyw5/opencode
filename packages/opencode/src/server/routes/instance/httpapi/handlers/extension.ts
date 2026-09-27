import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Extension } from "@/extension"
import { NotFoundError } from "@/extension/registry"
import { RootHttpApi } from "../api"

function notFound(error: Error) {
  return error instanceof NotFoundError ? Effect.fail(new HttpApiError.NotFound({})) : Effect.die(error)
}

export const extensionHandlers = HttpApiBuilder.group(RootHttpApi, "extension", (handlers) =>
  Effect.gen(function* () {
    const extension = yield* Extension.Service

    const get = Effect.fn("ExtensionHttpApi.get")(function* (ctx: {
      params: { id: Parameters<typeof extension.get>[0] }
    }) {
      return yield* extension.get(ctx.params.id).pipe(Effect.catch(notFound))
    })

    const setEnabled = (enabled: boolean) =>
      Effect.fn(`ExtensionHttpApi.${enabled ? "enable" : "disable"}`)(function* (ctx: {
        params: { id: Parameters<typeof extension.setEnabled>[0] }
      }) {
        return yield* extension.setEnabled(ctx.params.id, enabled).pipe(Effect.catch(notFound))
      })

    return handlers
      .handle("list", () => extension.list().pipe(Effect.orDie))
      .handle("get", get)
      .handle("enable", setEnabled(true))
      .handle("disable", setEnabled(false))
  }),
)
