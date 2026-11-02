import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Issue } from "@/issue/issue"
import { RootHttpApi } from "../api"

export const issueHandlers = HttpApiBuilder.group(RootHttpApi, "issue", (handlers) =>
  handlers
    .handle("list", ({ query }) => Effect.sync(() => Issue.list(query)))
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const result = Issue.get(params.issueID)
        if (!result) return yield* new HttpApiError.NotFound({})
        return result
      }),
    )
    .handle("mark", ({ params, payload }) =>
      Effect.gen(function* () {
        const result = Issue.mark(params.issueID, payload.action)
        if (!result) return yield* new HttpApiError.NotFound({})
        return result
      }),
    ),
)
