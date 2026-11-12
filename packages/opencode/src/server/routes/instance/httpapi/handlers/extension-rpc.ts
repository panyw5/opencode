import { Effect, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Extension } from "@/extension"
import { ExtensionRuntime } from "@/extension/runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { LocationLifecycle } from "@/project/location-lifecycle"
import { Plugin } from "@/plugin"
import { NotFoundError as ExtensionRegistryNotFoundError } from "@/extension/registry"
import { ExtensionID, type Info } from "@/extension/schema"
import { ExtensionRpcError, InvalidRequestError, ServiceUnavailableError, TimeoutError, UnknownError } from "../errors"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { RootHttpApi } from "../api"

export const RPC_TIMEOUT_HEADER = "x-opencode-rpc-timeout"
export const DEFAULT_RPC_TIMEOUT_MS = 120_000
export const MAX_RPC_TIMEOUT_MS = 600_000

/**
 * One extension RPC invocation, handed to the extension runtime by the HTTP
 * layer. `signal` is always provided: it aborts when the caller disconnects or
 * the request times out, and the runtime must honor it while looking up and
 * running the handler.
 */
export type ExtensionRpcCall = {
  readonly id: ExtensionID
  readonly method: string
  readonly input: unknown
  readonly directory?: string
  readonly signal: AbortSignal
}

/**
 * Typed seam between the HTTP route and the extension runtime. The runtime
 * (packages/opencode/src/extension/runtime) implements `rpc` with exactly this
 * shape and is installed at module load below, so the route never imports the
 * runtime lazily at request time. Tests install a replacement via
 * `installExtensionRpcAdapter`.
 */
export interface ExtensionRpcAdapter {
  readonly call: (call: ExtensionRpcCall) => Promise<unknown>
}

const adapterRef: { current?: ExtensionRpcAdapter } = {}

/** Install the process-level extension RPC adapter. Idempotent, last write wins. */
export function installExtensionRpcAdapter(adapter: ExtensionRpcAdapter) {
  adapterRef.current = adapter
}

export function extensionRpcAdapter(): ExtensionRpcAdapter | undefined {
  return adapterRef.current
}

/** Remove the installed adapter. Intended for tests. */
export function resetExtensionRpcAdapter() {
  delete adapterRef.current
}

installExtensionRpcAdapter({ call: (call) => ExtensionRuntime.rpc(call) })

/**
 * Lookup failures are reported by the runtime through typed sentinel errors.
 * They are recognized by `error.name` (and the kit's duck-typed
 * `{ name: "ExtensionRpcError", code }` shape) so the HTTP layer stays decoupled
 * from the runtime module's class identities.
 */
const LOOKUP_ERROR_NAMES = new Set(["ExtensionRpcNotFoundError", "ExtensionNotFoundError"])

function mapAdapterError(error: unknown): HttpApiError.NotFound | ExtensionRpcError | UnknownError {
  if (error instanceof Error && LOOKUP_ERROR_NAMES.has(error.name)) return new HttpApiError.NotFound({})
  if (error instanceof Error && error.name === "ExtensionRpcError") {
    const code = (error as { code?: unknown }).code
    return new ExtensionRpcError({
      code: typeof code === "string" ? code : "unknown",
      message: error.message,
    })
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ExtensionRpcError" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return new ExtensionRpcError({
      code: (error as { code: string }).code,
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return new UnknownError({ message: error instanceof Error ? error.message : String(error) })
}

function requestTimeoutMs(request: HttpServerRequest.HttpServerRequest): number {
  const raw = request.headers[RPC_TIMEOUT_HEADER]
  if (!raw) return DEFAULT_RPC_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RPC_TIMEOUT_MS
  return Math.min(Math.floor(parsed), MAX_RPC_TIMEOUT_MS)
}

/**
 * Directory semantics are explicit: a client-provided `?directory` routes to
 * that instance first; an explicit `?workspace` falls back to the directory the
 * workspace-routing middleware resolved; anything else stays process-level.
 * The middleware's implicit cwd fallback is never treated as a target.
 */
function rpcDirectory(url: URL, route: { readonly directory: string } | undefined): string | undefined {
  const explicit = url.searchParams.get("directory")
  if (explicit !== null && explicit !== "") return explicit
  if (url.searchParams.get("workspace") !== null && route) return route.directory
  return undefined
}

function notReady(info: Info) {
  return info.state !== "ready"
}

/**
 * Body contract: an optional `{ input?: unknown }` JSON object. A missing or
 * empty body means no input. Anything else that is not such an object is a 400.
 */
const parseRpcBody = Effect.fn("ExtensionRpcHttpApi.parseBody")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const text = yield* Effect.orDie(request.text)
  if (text.trim().length === 0) return undefined
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return yield* Effect.fail(
      new InvalidRequestError({ message: "Extension RPC body must be valid JSON", kind: "Payload" }),
    )
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return yield* Effect.fail(
      new InvalidRequestError({
        message: "Extension RPC body must be an object with an optional input field",
        kind: "Payload",
      }),
    )
  }
  return (json as { input?: unknown }).input
})

export const extensionRpcHandlers = HttpApiBuilder.group(RootHttpApi, "extension-rpc", (handlers) =>
  Effect.gen(function* () {
    const extension = yield* Extension.Service
    const lifecycle = yield* LocationLifecycle.Service
    const plugin = yield* Plugin.Service

    const missing = (error: Error) =>
      error instanceof ExtensionRegistryNotFoundError ? Effect.fail(new HttpApiError.NotFound({})) : Effect.die(error)

    const rpc = Effect.fn("ExtensionRpcHttpApi.rpc")(function* (ctx: { params: { id: ExtensionID; method: string } }) {
      const info = yield* extension.get(ctx.params.id).pipe(Effect.catch(missing))
      if (notReady(info)) return yield* Effect.fail(new HttpApiError.NotFound({}))

      const request = yield* HttpServerRequest.HttpServerRequest
      const input = yield* parseRpcBody(request)

      const adapter = extensionRpcAdapter()
      if (!adapter) {
        return yield* Effect.fail(
          new ServiceUnavailableError({
            message: "Extension server runtime is not available",
            service: "extension",
          }),
        )
      }

      const url = new URL(request.url, "http://localhost")
      const route = Option.getOrUndefined(yield* Effect.serviceOption(WorkspaceRouteContext))
      const directory = rpcDirectory(url, route)
      const timeoutMs = requestTimeoutMs(request)
      const controller = new AbortController()

      // Keep process-level RPC free of an implicit cwd instance. For an explicit
      // directory, acquire the lifecycle lease first: bootstrapping initializes
      // Plugin.state and its per-instance extension RPC table, and InstanceRef
      // supplies the normalized key used by that table.
      const invoke = (target: string | undefined) =>
        Effect.tryPromise({
          try: () =>
            adapter.call({
              id: ctx.params.id,
              method: ctx.params.method,
              input,
              directory: target,
              signal: controller.signal,
            }),
          catch: mapAdapterError,
        })
      const execute = directory
        ? lifecycle
            .provide(
              { directory, purpose: "http-request" },
              Effect.gen(function* () {
                const instance = yield* InstanceRef
                if (!instance) return yield* Effect.die(new Error("Extension RPC instance context unavailable"))
                // The instance can stay warm while hot reload invalidates only its
                // plugin hooks, so materialize those hooks on every scoped call.
                yield* plugin.init()
                return yield* invoke(instance.directory)
              }),
            )
            .pipe(
              Effect.catchIf(
                (error): error is LocationLifecycle.AdmissionError =>
                  error instanceof LocationLifecycle.LocationUnavailable ||
                  error instanceof LocationLifecycle.LocationDeleting ||
                  error instanceof LocationLifecycle.LocationDeleted,
                () => Effect.fail(new HttpApiError.NotFound({})),
              ),
            )
        : invoke(undefined)
      const outcome = yield* execute.pipe(
        Effect.onInterrupt(() => Effect.sync(() => controller.abort(new Error("Extension RPC request canceled")))),
        Effect.timeoutOption(timeoutMs),
      )

      if (Option.isNone(outcome)) {
        return yield* Effect.fail(
          new TimeoutError({
            message: `Extension RPC ${ctx.params.id}.${ctx.params.method} timed out after ${timeoutMs}ms`,
            operation: "extension.rpc",
          }),
        )
      }
      return { result: outcome.value }
    })

    return handlers.handle("rpc", rpc)
  }),
)
