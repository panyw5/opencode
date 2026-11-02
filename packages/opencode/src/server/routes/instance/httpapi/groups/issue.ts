import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Issue } from "@/issue/issue"
import { QueryBoolean } from "./query"

export const IssueApi = HttpApi.make("issue").add(
  HttpApiGroup.make("issue").add(
    HttpApiEndpoint.get("list", "/global/issue", {
      query: Schema.Struct({
        directory: Schema.optional(Schema.String),
        sessionID: Schema.optional(Schema.String),
        before: Schema.optional(Schema.String),
        attention: Schema.optional(QueryBoolean),
        limit: Schema.optional(
          Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
        ),
      }),
      success: Schema.Array(Issue.Info),
    }).annotateMerge(OpenApi.annotations({ identifier: "issue.list", summary: "List durable diagnostic issues" })),
    HttpApiEndpoint.get("get", "/global/issue/:issueID", {
      params: Schema.Struct({ issueID: Schema.String }),
      success: Schema.Struct({ issue: Issue.Info, history: Schema.Array(Issue.Occurrence) }),
      error: HttpApiError.NotFound,
    }).annotateMerge(OpenApi.annotations({ identifier: "issue.get", summary: "Read issue and recovery history" })),
    HttpApiEndpoint.patch("mark", "/global/issue/:issueID", {
      params: Schema.Struct({ issueID: Schema.String }),
      payload: Schema.Struct({ action: Schema.Literals(["read", "acknowledge"]) }),
      success: Issue.Info,
      error: HttpApiError.NotFound,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "issue.mark", summary: "Mark read or acknowledge without resolving an issue" }),
    ),
  ),
)
