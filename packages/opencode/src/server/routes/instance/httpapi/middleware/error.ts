import { NamedError } from "@opencode-ai/core/util/error"
import * as Log from "@opencode-ai/core/util/log"
import { Cause, Effect, Option } from "effect"
import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http"

const log = Log.create({ service: "server" })

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return {
    name: typeof error,
    message: String(error),
  }
}

function requestDetails(request: HttpServerRequest.HttpServerRequest | undefined) {
  if (!request) return undefined
  const url = new URL(request.url, "http://localhost")
  return {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    directory: url.searchParams.get("directory") ?? request.headers["x-opencode-directory"],
    workspace: url.searchParams.get("workspace") ?? request.headers["x-opencode-workspace"],
    host: request.headers.host,
    userAgent: request.headers["user-agent"],
  }
}

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const request = Option.getOrUndefined(yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest))
        const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
          if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
          if (HttpServerError.isHttpServerError(reason.defect)) return false
          if (HttpServerRespondable.isRespondable(reason.defect)) return false
          return true
        })
        if (!defect) return yield* Effect.failCause(cause)

        const error = defect.defect
        const ref = `err_${crypto.randomUUID().slice(0, 8)}`

        log.error("failed", {
          ref,
          request: requestDetails(request),
          error: errorDetails(error),
          cause: Cause.pretty(cause),
        })

        return HttpServerResponse.jsonUnsafe(
          new NamedError.Unknown({
            message: "Unexpected server error. Check server logs for details.",
            ref,
          }).toObject(),
          { status: 500 },
        )
      }),
    ),
  ),
).layer
