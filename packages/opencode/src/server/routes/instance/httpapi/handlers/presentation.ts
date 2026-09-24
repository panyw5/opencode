import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import { readArtifact } from "@/session/presentation"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/session/schema"
import { InstanceHttpApi } from "../api"

export const presentationHandlers = HttpApiBuilder.group(InstanceHttpApi, "presentation", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const get = Effect.fn("PresentationHttpApi.get")(function* (ctx: { params: { sessionID: string; artifactID: string }; query: { variant?: "thumbnail" | "original" } }) {
      const instance = yield* InstanceState.context
      const session = yield* sessions.get(ctx.params.sessionID as SessionID).pipe(Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))))
      if (session.directory !== instance.directory) return yield* new HttpApiError.NotFound({})
      const result = yield* Effect.promise(() => readArtifact({ sessionID: ctx.params.sessionID, artifactID: ctx.params.artifactID, variant: ctx.query.variant }))
      if (!result) return yield* new HttpApiError.NotFound({})
      return HttpServerResponse.uint8Array(result.body, {
        contentType: result.mime,
        headers: {
          "cache-control": "private, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      })
    })
    return handlers.handle("get", get)
  }),
)
