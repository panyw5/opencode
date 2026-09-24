import { Effect, Schema } from "effect"
import path from "node:path"
import { realpath } from "node:fs/promises"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import DESCRIPTION from "./present_file.txt"
import { snapshot, type PresentationPurpose } from "@/session/presentation"

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "Image path to present (absolute or relative to the workspace)" }),
  purpose: Schema.optional(Schema.Literals(["result", "verification", "diagram"])),
  caption: Schema.optional(Schema.String),
})

export const PresentFileTool = Tool.define(
  "present_file",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { filePath: string; purpose?: PresentationPurpose; caption?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          if (params.filePath.length > 4096) return yield* Effect.die(new Error("present_file filePath is too long"))
          const caption = params.caption === undefined ? undefined : Array.from(params.caption).slice(0, 240).join("")
          const sourcePath = path.isAbsolute(params.filePath) ? params.filePath : path.join(instance.directory, params.filePath)
          const canonicalPath = yield* Effect.tryPromise({ try: () => realpath(sourcePath), catch: () => new Error(`File not found: ${sourcePath}`) }).pipe(Effect.orDie)
          yield* assertExternalDirectoryEffect(ctx, canonicalPath, { kind: "file" })
          yield* ctx.ask({ permission: "read", patterns: [path.relative(instance.worktree, canonicalPath)], always: ["*"], metadata: {} })
          const artifact = yield* Effect.tryPromise({
            try: () => snapshot({ sessionID: ctx.sessionID, sourcePath: canonicalPath, purpose: params.purpose ?? "result", caption }),
            catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
          }).pipe(Effect.orDie)
          return {
            title: artifact.filename,
            metadata: { presentation: artifact },
            output: `Presented ${artifact.filename} (${artifact.mime}).`,
          }
        }),
    }
  }),
)
