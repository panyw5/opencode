import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_close.txt"
import { Browser } from "@/browser"

const Parameters = Schema.Struct({ consultation_id: Browser.ConsultationParameter })

export const BrowserCloseTool = Tool.define(
  "browser_close",
  Effect.gen(function* () {
    const browser = yield* Browser.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_close",
            patterns: [],
            always: ["*"],
            metadata: { action: "close" },
          })

          yield* browser.close(
            ctx.sessionID,
            params.consultation_id ? { consultationID: params.consultation_id } : undefined,
          )
          return {
            title: "Close tab",
            output: [
              "Closed this session's embedded browser tab.",
              params.consultation_id
                ? "The original consultation remains reserved. Reopen its recorded URL with browser_navigate and resume it; do not resubmit."
                : "Resources are freed; call browser_navigate to reopen a fresh tab later.",
            ].join("\n"),
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
