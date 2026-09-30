import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_click.txt"
import { Browser } from "@/browser"

const Parameters = Schema.Struct({
  uid: Schema.String.annotate({
    description: "Element uid from the most recent browser_read snapshot",
  }),
})

export const BrowserClickTool = Tool.define(
  "browser_click",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const state = yield* browser.requireState(ctx.sessionID)
          yield* ctx.ask({
            permission: "browser_click",
            patterns: [state.url],
            always: [],
            metadata: { action: "click", url: state.url, uid: params.uid },
          })

          const after = yield* browser.click(ctx.sessionID, params.uid)
          const lines = [`Clicked element ${params.uid}.`]
          if (after) {
            lines.push(`Current page: ${after.url}`, `Title: ${after.title}`)
            if (after.url !== state.url) lines.push("The click navigated to a new page; take a new snapshot with browser_read.")
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
