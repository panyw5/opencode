import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_read.txt"
import { Browser } from "@/browser"

const Parameters = Schema.Struct({ consultation_id: Browser.ConsultationParameter })

export const BrowserReadTool = Tool.define(
  "browser_read",
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
            permission: "browser_read",
            patterns: [state.url],
            always: ["*"],
            metadata: { action: "read", url: state.url },
          })

          const snapshot = yield* browser.snapshot(ctx.sessionID, target)
          const lines = [
            `Page: ${snapshot.url}`,
            `Title: ${snapshot.title}`,
            `Elements (${snapshot.nodes.length}):`,
            ...snapshot.nodes.map((node) => {
              const flags = [node.focused ? "focused" : undefined].filter(Boolean)
              const value = node.value !== undefined && node.value !== "" ? ` value="${node.value}"` : ""
              const suffix = flags.length ? ` (${flags.join(", ")})` : ""
              return `- [${node.uid}] ${node.role} "${node.name}"${value}${suffix}`
            }),
          ]
          return {
            title: snapshot.url,
            output: lines.join("\n"),
            metadata: { url: snapshot.url, title: snapshot.title, nodes: snapshot.nodes.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
