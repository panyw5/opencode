import { Effect, Schema } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"
import DESCRIPTION from "./browser_screenshot.txt"
import { Browser } from "@/browser"

const Parameters = Schema.Struct({
  consultation_id: Browser.ConsultationParameter,
  fullPage: Schema.optional(
    Schema.Boolean.annotate({
      description: "Capture the entire scrollable page instead of just the visible viewport. Defaults to false.",
    }),
  ),
})

// Screenshots are persisted under the project's tmp attachments dir (gitignored,
// same convention as the editor's temporary markdown attachments) so they stay
// reusable after the tool call: present them with present_file, attach them to
// prompts, or hand the path to other tools. The attachment references the file
// via a file:// URL instead of an inline base64 copy — the session keeps only
// the path, and the model pipeline reads the bytes from disk at request time.
// If the disk write fails we fall back to the inline data URL so the screenshot
// is not lost.
const saveScreenshotFile = Effect.fn("browser_screenshot.save")(function* (base64: string) {
  const instance = yield* InstanceState.context
  const dir = path.join(instance.worktree, ".opencode", "tmp", "attachments")
  const filename = `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.png`
  const target = path.join(dir, filename)
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true })
      await writeFile(target, Buffer.from(base64, "base64"), { flag: "wx" })
    },
    catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
  })
  return target
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
          const target = params.consultation_id ? { consultationID: params.consultation_id } : undefined
          const state = yield* browser.requireState(ctx.sessionID, target)
          yield* ctx.ask({
            permission: "browser_screenshot",
            patterns: [state.url],
            always: ["*"],
            metadata: { action: "screenshot", url: state.url, fullPage: params.fullPage === true },
          })

          const shot = yield* browser.screenshot(ctx.sessionID, { ...target, fullPage: params.fullPage === true })
          const saved = yield* saveScreenshotFile(shot.data).pipe(Effect.option)
          const filePath = saved._tag === "Some" ? saved.value : undefined
          return {
            title: state.url,
            output: `Screenshot captured: ${state.url}${params.fullPage ? " (full page)" : ""}${filePath ? `\nSaved to: ${filePath} — present it with present_file if the user should see it.` : "\n(not saved to disk: write failed)"}`,
            metadata: { url: state.url, mime: shot.mime, path: filePath },
            attachments: filePath
              ? [
                  {
                    type: "file" as const,
                    mime: "image/png",
                    url: pathToFileURL(filePath).href,
                    // The attachment names the on-disk copy; the model pipeline
                    // resolves the bytes from this file at request time.
                    filename: filePath,
                  },
                ]
              : [
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
