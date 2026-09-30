import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_screenshot.txt"
import { Browser } from "@/browser"

const Parameters = Schema.Struct({
  fullPage: Schema.optional(
    Schema.Boolean.annotate({
      description: "Capture the entire scrollable page instead of just the viewport. Defaults to false.",
    }),
  ),
})

export const BrowserScreenshotTool = Tool.define(
  "browser_screenshot",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const state = yield* browser.requireState(ctx.sessionID)
          yield* ctx.ask({
            permission: "browser_screenshot",
            patterns: [state.url],
            always: ["*"],
            metadata: { action: "screenshot", url: state.url, fullPage: params.fullPage === true },
          })

          const shot = yield* browser.screenshot(ctx.sessionID, { fullPage: params.fullPage === true })
          return {
            title: state.url,
            output: `Screenshot captured: ${state.url}${params.fullPage ? " (full page)" : ""}`,
            metadata: { url: state.url, mime: shot.mime },
            attachments: [
              {
                type: "file" as const,
                mime: "image/png",
                url: `data:image/png;base64,${shot.data}`,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
