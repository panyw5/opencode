import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_scroll.txt"
import { Browser } from "@/browser"

const Parameters = Schema.Struct({
  consultation_id: Browser.ConsultationParameter,
  uid: Schema.optional(
    Schema.String.annotate({
      description:
        "Element uid from the most recent browser_read snapshot. When given, the page scrolls until this element is centered in view; direction and amount are ignored.",
    }),
  ),
  direction: Schema.optional(
    Schema.Literals(["up", "down"]).annotate({
      description: "Wheel direction when uid is not given. Defaults to down.",
    }),
  ),
  amount: Schema.optional(
    Schema.Number.annotate({
      description: "Pixels to wheel when uid is not given. Defaults to roughly one viewport height.",
    }),
  ),
})

export const BrowserScrollTool = Tool.define(
  "browser_scroll",
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
            permission: "browser_scroll",
            patterns: [state.url],
            always: ["*"],
            metadata: {
              action: "scroll",
              url: state.url,
              uid: params.uid,
              direction: params.direction,
              amount: params.amount,
            },
          })

          const after = yield* browser.scroll(ctx.sessionID, {
            ...target,
            uid: params.uid,
            direction: params.direction,
            amount: params.amount,
          })
          const lines = [
            params.uid
              ? `Scrolled element ${params.uid} into view.`
              : `Scrolled ${params.direction ?? "down"}${params.amount ? ` by ${Math.round(params.amount)}px` : " by one viewport"}.`,
          ]
          if (after) lines.push(`Current page: ${after.url}`, `Title: ${after.title}`)
          return {
            title: state.url,
            output: lines.join("\n"),
            metadata: { url: after?.url ?? state.url, title: after?.title ?? state.title, uid: params.uid },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
