import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_console.txt"
import { Browser } from "@/browser"

const Parameters = Schema.Struct({
  consultation_id: Browser.ConsultationParameter,
  all: Schema.optional(
    Schema.Boolean.annotate({
      description: "Return the full console buffer instead of only new entries since the last call.",
    }),
  ),
})

export const BrowserConsoleTool = Tool.define(
  "browser_console",
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
            permission: "browser_console",
            patterns: [state.url],
            always: ["*"],
            metadata: { action: "console", url: state.url, all: params.all === true },
          })

          const entries = yield* browser.console(ctx.sessionID, { ...target, ...(params.all ? { since: 0 } : {}) })
          const errors = entries.filter((entry) => entry.level === "error")
          const warnings = entries.filter((entry) => entry.level === "warn")
          const others = entries.filter((entry) => entry.level !== "error" && entry.level !== "warn")

          const lines: string[] = [`Console entries since last read: ${entries.length}`]
          const format = (entry: Browser.ConsoleEntry) => `[${entry.level}] ${entry.text}`
          if (errors.length) lines.push("Errors:", ...errors.map(format))
          if (warnings.length) lines.push("Warnings:", ...warnings.map(format))
          if (others.length) lines.push("Other:", ...others.map(format))
          if (!entries.length) lines.push("No new console entries.")

          return {
            title: state.url,
            output: lines.join("\n"),
            metadata: {
              url: state.url,
              errors: errors.length,
              warnings: warnings.length,
              total: entries.length,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
