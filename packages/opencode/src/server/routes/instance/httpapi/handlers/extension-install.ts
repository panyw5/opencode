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
    // InstallError messages are curated at the source; pass them through so
    // per-situation guidance (cleanup pending, already in progress, ...) and
    // the generic fallbacks stay in sync from one place.
    switch (error.code) {
      case "invalid":
        return new InvalidRequestError({ message: error.message })
      case "unauthorized":
        return new ForbiddenError({ message: error.message })
      case "busy":
      case "conflict":
        return new ConflictError({ message: error.message })
      case "expired":
        return new HttpApiError.Gone({})
      case "failed":
        return new UpstreamError({ message: error.message, service: "extensions" })
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
    const rawPayload = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const raw = yield* request.json.pipe(
        Effect.mapError(() => new InvalidRequestError({ message: "Invalid extension request" })),
      )
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return yield* new InvalidRequestError({ message: "Invalid extension request" })
      return raw as Record<string, unknown>
    })
    const token = (headers: { "x-opencode-extension-token": string }) => headers["x-opencode-extension-token"]
    const commit =
      (kind: InstallRequest["kind"]) =>
      (ctx: {
        headers: { "x-opencode-extension-token": string }
        payload: { operationId: string; enable?: boolean; acceptRegistryUpgrade?: boolean }
        params?: { id: string }
      }) =>
        Effect.gen(function* () {
          yield* allowed()
          // Decoders may strip unknown properties; inspect the original envelope before committing.
          const raw = yield* rawPayload
          if (kind === "uninstall" && ("enable" in raw || "acceptRegistryUpgrade" in raw))
            return yield* new InvalidRequestError({ message: "Removal does not accept installation options" })
          return yield* run(async (service) => {
            const capability = token(ctx.headers)
            const status = await service.status(ctx.payload.operationId, capability)
            if (status.kind !== kind || (ctx.params?.id && status.id !== ctx.params.id)) {
              throw new InstallError("conflict", "Operation does not match this endpoint")
            }
            return service.commit(
              ctx.payload.operationId,
              capability,
              kind === "uninstall"
                ? {}
                : kind === "install"
                  ? { enable: ctx.payload.enable, acceptRegistryUpgrade: ctx.payload.acceptRegistryUpgrade }
                  : { acceptRegistryUpgrade: ctx.payload.acceptRegistryUpgrade },
            )
          })
        })
    return handlers
      .handle("prepare", (ctx) =>
        Effect.gen(function* () {
          yield* allowed()
          const value = yield* rawPayload
          const source =
            value.source && typeof value.source === "object" ? (value.source as Record<string, unknown>) : undefined
          if (
            ["release", "archive", "staged", "stagedRelease", "path"].some(
              (key) => key in value || (source && key in source),
            )
          )
            return yield* new InvalidRequestError({ message: "Staged releases are desktop-only" })
          if (value.kind === "update" && ["source", "version", "target"].filter((key) => key in value).length !== 1) {
            return yield* new InvalidRequestError({ message: "Choose exactly one of source, version or target" })
          }
          if (value.kind === "install" && ("version" in value || "target" in value))
            return yield* new InvalidRequestError({ message: "Installation requires a source, not version or target" })
          if (value.kind === "uninstall" && ["source", "version", "target"].some((key) => key in value))
            return yield* new InvalidRequestError({ message: "Removal does not accept a source, version or target" })
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
      .handle("unlock", () => run((service) => service.unlock()))
  }),
)
