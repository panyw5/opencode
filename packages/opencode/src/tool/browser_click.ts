import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_click.txt"
import { Browser } from "@/browser"

const Parameters = Schema.Struct({
  consultation_id: Browser.ConsultationParameter,
  position: Schema.optional(Schema.Struct({ x: Schema.Number, y: Schema.Number })).annotate({
    description:
      "Optional normalized point inside the element (0..1). Useful for sliders: x=0.98, y=0.5 clicks near its right end. Default is the center.",
  }),
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
          const target = params.consultation_id ? { consultationID: params.consultation_id } : undefined
          const state = yield* browser.requireState(ctx.sessionID, target)
          yield* ctx.ask({
            permission: "browser_click",
            patterns: [state.url],
            always: [],
            metadata: { action: "click", url: state.url, uid: params.uid },
          })

          const after = yield* browser.click(ctx.sessionID, params.uid, { ...target, position: params.position })
          const lines = [`Clicked element ${params.uid}.`]
          if (after) {
            lines.push(`Current page: ${after.url}`, `Title: ${after.title}`)
            if (after.url !== state.url)
              lines.push("The click navigated to a new page; take a new snapshot with browser_read.")
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
