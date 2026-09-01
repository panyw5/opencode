import path from "path"
import { Effect } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { realpathSync } from "node:fs"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.external-directory" })

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return

  const mathRoot = ctx.agent === "math-worker" ? process.env.OPENCODE_MATH_PROJECT_DIR : undefined
  if (mathRoot) {
    const canonical = (value: string) => {
      try {
        return realpathSync.native(value)
      } catch {
        return path.resolve(value)
      }
    }
    const root = canonical(mathRoot)
    const full = canonical(target)
    const relative = path.relative(root, full)
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      return
    }
    log.warn("math worker blocked outside problem workspace", { root, target: full })
    return yield* Effect.die(new Error(`math-worker may only read its problem workspace: ${root}`))
  }

  if (options?.bypass) return

  const ins = yield* InstanceState.context
  const full = process.platform === "win32" ? AppFileSystem.normalizePath(target) : target
  if (containsPath(full, ins)) return

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options).pipe(Effect.provide(EffectLogger.layer)))
}
