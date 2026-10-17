import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstallError, type InstallRequest } from "@/extension/install"
import { installation, type InstallationService } from "@/extension/install-service"
import { RootHttpApi } from "../api"
import { ConflictError, ForbiddenError, InvalidRequestError, UpstreamError } from "../errors"

let adapter: InstallationService | undefined
export function installExtensionInstallAdapter(next: InstallationService) {
  adapter = next
}
export function resetExtensionInstallAdapter() {
  adapter = undefined
}

function mapped(error: unknown) {
  if (error instanceof InstallError) {
    switch (error.code) {
      case "invalid":
        return new InvalidRequestError({ message: "Invalid extension operation" })
      case "unauthorized":
        return new ForbiddenError({ message: "Invalid operation confirmation" })
      case "busy":
      case "conflict":
        return new ConflictError({ message: "Extension changed or is busy; prepare again" })
      case "expired":
        return new HttpApiError.Gone({})
    }
  }
  return new UpstreamError({ message: "Extension operation failed", service: "extensions" })
}

export const extensionInstallHandlers = HttpApiBuilder.group(RootHttpApi, "extensionInstall", (handlers) =>
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const allowed = () =>
      flags.pure || flags.disableExtensions
        ? Effect.fail(new ForbiddenError({ message: "Extension management is disabled" }))
        : Effect.void
    const run = <T>(fn: (service: InstallationService) => Promise<T>) =>
      Effect.gen(function* () {
        yield* allowed()
        return yield* Effect.tryPromise({ try: () => fn(adapter ?? installation()), catch: mapped })
      })
    const token = (headers: { "x-opencode-extension-token": string }) => headers["x-opencode-extension-token"]
    const commit =
      (kind: InstallRequest["kind"]) =>
      (ctx: {
        headers: { "x-opencode-extension-token": string }
        payload: { operationId: string; enable?: boolean }
        params?: { id: string }
      }) =>
        run(async (service) => {
          const capability = token(ctx.headers)
          const status = await service.status(ctx.payload.operationId, capability)
          if (status.kind !== kind || (ctx.params?.id && status.id !== ctx.params.id)) {
            throw new InstallError("conflict", "Operation does not match this endpoint")
          }
          return service.commit(
            ctx.payload.operationId,
            capability,
            kind === "install" ? { enable: ctx.payload.enable } : {},
          )
        })
    return handlers
      .handle("prepare", (ctx) =>
        Effect.gen(function* () {
          yield* allowed()
          const request = yield* HttpServerRequest.HttpServerRequest
          const raw = yield* request.json.pipe(
            Effect.mapError(() => new InvalidRequestError({ message: "Invalid extension request" })),
          )
          if (!raw || typeof raw !== "object")
            return yield* new InvalidRequestError({ message: "Invalid extension request" })
          const value = raw as Record<string, unknown>
          if (value.kind === "update" && "source" in value && "version" in value) {
            return yield* new InvalidRequestError({ message: "Choose source or version, not both" })
          }
          if (
            value.source &&
            typeof value.source === "object" &&
            (value.source as { type?: string }).type === "local"
          ) {
            return yield* new InvalidRequestError({ message: "Local archives are CLI-only" })
          }
          return yield* run((service) => service.prepare(ctx.payload))
        }),
      )
      .handle("install", commit("install"))
      .handle("update", commit("update"))
      .handle("uninstall", commit("uninstall"))
      .handle("status", (ctx) => run((service) => service.status(ctx.params.operationId, token(ctx.headers))))
      .handle("cancel", (ctx) => run((service) => service.cancel(ctx.params.operationId, token(ctx.headers))))
  }),
)
