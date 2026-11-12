import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Extension } from "@/extension"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Loaded } from "@/extension/manifest"
import { ExtensionRegistry, NotFoundError, SettingsError } from "@/extension/registry"
import type { ExtensionID } from "@/extension/schema"
import { ExtensionRuntime, ExtensionMutationError } from "@/extension/runtime"
import { ConflictError } from "../errors"
import { RootHttpApi } from "../api"

function notFound(error: Error) {
  return error instanceof NotFoundError ? Effect.fail(new HttpApiError.NotFound({})) : Effect.die(error)
}

// Mirrors the asset base builder in @/extension so the patched extension is
// returned with usable web asset URLs without widening the Extension service.
function assetBase(manifest: Loaded) {
  return `/extension-asset/${Extension.assetToken()}/${encodeURIComponent(manifest.id)}/${encodeURIComponent(manifest.versionSegment)}/`
}

/**
 * Resolve the real (unmasked) settings of an extension: declared settings with
 * stored values falling back to manifest defaults. Secrets stay plaintext
 * because this view is only ever handed to the extension runtime itself, never
 * returned to clients.
 */
async function resolveSettings(id: ExtensionID) {
  const linked = await ExtensionRegistry.linked(id)
  if (!linked) return {}
  const definitions = linked.manifest.contributes.settings ?? {}
  const stored = linked.row.settings ?? {}
  const resolved: Record<string, unknown> = {}
  for (const [key, definition] of Object.entries(definitions)) {
    resolved[key] = key in stored ? stored[key] : definition.default
  }
  return resolved
}

export const extensionHandlers = HttpApiBuilder.group(RootHttpApi, "extension", (handlers) =>
  Effect.gen(function* () {
    const extension = yield* Extension.Service
    const flags = yield* RuntimeFlags.Service
    const disabled = () => flags.pure || flags.disableExtensions

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

    const retry = Effect.fn("ExtensionHttpApi.retry")(function* (ctx: { params: { id: ExtensionID } }) {
      return yield* extension.retry(ctx.params.id).pipe(
        Effect.catch((error): Effect.Effect<never, HttpApiError.NotFound | ConflictError> => {
          if (error instanceof NotFoundError) return Effect.fail(new HttpApiError.NotFound({}))
          if (error instanceof ExtensionMutationError) {
            return Effect.fail(new ConflictError({ message: error.message, resource: ctx.params.id }))
          }
          return Effect.die(error)
        }),
      )
    })

    const updateSettings = Effect.fn("ExtensionHttpApi.updateSettings")(function* (ctx: {
      params: { id: ExtensionID }
      payload: Record<string, unknown>
    }) {
      if (disabled()) return yield* Effect.die(new Error(`Extensions are disabled: ${ctx.params.id}`))
      // JSON cannot express `undefined`, so an explicit `null` resets a stored
      // value (the registry treats `undefined` as "remove key").
      const patch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(ctx.payload)) {
        patch[key] = value === null ? undefined : value
      }
      const info = yield* Effect.tryPromise({
        try: () => ExtensionRegistry.updateSettings(ctx.params.id, patch, assetBase),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.catch(
          (
            error,
          ): Effect.Effect<
            Awaited<ReturnType<typeof ExtensionRegistry.updateSettings>>,
            HttpApiError.NotFound | HttpApiError.BadRequest
          > => {
            if (error instanceof NotFoundError) return Effect.fail(new HttpApiError.NotFound({}))
            if (error instanceof SettingsError) return Effect.fail(new HttpApiError.BadRequest({}))
            return Effect.die(error)
          },
        ),
      )
      // Notify the extension runtime with the real (unmasked) settings so
      // `host.settings.onDidChange` listeners observe actual values.
      yield* Effect.ignore(
        Effect.tryPromise({
          try: () =>
            resolveSettings(ctx.params.id).then((settings) => ExtensionRuntime.notifySettings(ctx.params.id, settings)),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
      )
      return info
    })

    return handlers
      .handle("list", () => extension.list().pipe(Effect.orDie))
      .handle("get", get)
      .handle("enable", setEnabled(true))
      .handle("disable", setEnabled(false))
      .handle("retry", retry)
      .handle("updateSettings", updateSettings)
  }),
)
