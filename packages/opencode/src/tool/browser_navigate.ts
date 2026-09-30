import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_navigate.txt"
import { Browser } from "@/browser"

const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description:
      "Absolute URL (http://, https://, or file://) or an absolute local file path (e.g. /path/to/report.html, ~/report.html) to open",
  }),
})

export const BrowserNavigateTool = Tool.define(
  "browser_navigate",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_navigate",
            patterns: [params.url],
            always: ["*"],
            metadata: { action: "navigate", url: params.url },
          })

          const state = yield* browser.navigate(ctx.sessionID, params.url)
          return {
            title: params.url,
            output: [
              `Navigated to ${state.url}`,
              `Title: ${state.title}`,
              state.loading ? "The page is still loading; results may be partial." : "The page finished loading.",
              "Use browser_read to inspect the page structure.",
            ].join("\n"),
            metadata: { url: state.url, title: state.title, loading: state.loading },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
