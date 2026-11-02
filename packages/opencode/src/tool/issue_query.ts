import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Issue } from "@/issue/issue"
import { InstanceState } from "@/effect/instance-state"

const Parameters = Schema.Struct({
  issue_id: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  before: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))),
})
export const IssueQueryTool = Tool.define(
  "issue_query",
  Effect.succeed({
    description:
      "Read durable, redacted error and recovery records in the current project. Use issue_id to read recorded attempts. Read-only; cannot acknowledge or resolve issues. Results are paginated using before (last returned issue id). Tool output itself remains in the session transcript.",
    parameters: Parameters,
    codemode: "readonly" as const,
    execute: (params: Schema.Schema.Type<typeof Parameters>) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        const result = params.issue_id
          ? Issue.get(params.issue_id)
          : Issue.list({
              directory: ctx.directory,
              sessionID: params.session_id,
              before: params.before,
              limit: params.limit,
            })
        if (params.issue_id && result && !Array.isArray(result) && result.issue.directory !== ctx.directory)
          throw new Error("Issue is outside the current project")
        return {
          title: "Diagnostic issues",
          metadata: {},
          output: JSON.stringify(result ?? { error: "Issue not found" }, null, 2),
        }
      }),
  }),
)
