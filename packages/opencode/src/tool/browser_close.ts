import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_close.txt"
import { Browser } from "@/browser"

const Parameters = Schema.Struct({})

export const BrowserCloseTool = Tool.define(
  "browser_close",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_close",
            patterns: [],
            always: ["*"],
            metadata: { action: "close" },
          })

          yield* browser.close(ctx.sessionID)
          return {
            title: "Close tab",
            output: [
              "Closed this session's embedded browser tab.",
              "Resources are freed; call browser_navigate to reopen a fresh tab later.",
            ].join("\n"),
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
