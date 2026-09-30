import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_type.txt"
import { Browser } from "@/browser"

const Parameters = Schema.Struct({
  uid: Schema.String.annotate({
    description: "Element uid from the most recent browser_read snapshot",
  }),
  text: Schema.String.annotate({ description: "Text to insert into the element" }),
  submit: Schema.optional(
    Schema.Boolean.annotate({
      description: "Press Enter after typing (search boxes, forms). Waits for the resulting navigation.",
    }),
  ),
})

export const BrowserTypeTool = Tool.define(
  "browser_type",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const state = yield* browser.requireState(ctx.sessionID)
          yield* ctx.ask({
            permission: "browser_type",
            patterns: [state.url],
            always: [],
            metadata: { action: "type", url: state.url, uid: params.uid, submit: params.submit === true },
          })

          const after = yield* browser.type(ctx.sessionID, params.uid, params.text, {
            submit: params.submit === true,
          })
          const lines = [
            `Typed ${params.text.length} character(s) into element ${params.uid}.`,
            `Current page: ${after?.url ?? state.url}`,
          ]
          if (after && after.url !== state.url) {
            lines.push(`Title: ${after.title}`, "The action navigated to a new page; take a new snapshot with browser_read.")
          }
          return {
            title: state.url,
            output: lines.join("\n"),
            metadata: { url: after?.url ?? state.url, title: after?.title ?? state.title, uid: params.uid },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
