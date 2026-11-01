import path from "path"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { withTransientReadRetry } from "@/util/effect-http-client"
import * as Log from "@opencode-ai/core/util/log"
import { Glob } from "@opencode-ai/core/util/glob"
import { InstructionSource } from "./instruction-source"
import { InstructionGuidance } from "./instruction-guidance"
import { Global } from "@opencode-ai/core/global"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

const files = (disableClaudeCodePrompt: boolean) => [
  "AGENTS.md",
  ...(disableClaudeCodePrompt ? [] : ["CLAUDE.md"]),
  "CONTEXT.md", // deprecated
]
const log = Log.create({ service: "session.instruction" })
const missing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (("reason" in error && (error.reason as { _tag?: string })?._tag === "NotFound") ||
    ("code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))))

function extract(messages: MessageV2.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (
        part.type === "tool" &&
        part.state.status === "completed" &&
        (part.tool === "read" || (part.tool === "execute" && part.state.metadata?.codemode === true))
      ) {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

export interface Interface {
  readonly source: (messages: MessageV2.WithParts[]) => InstructionSource.Source
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, AppFileSystem.Error>
  readonly system: () => Effect.Effect<string[], AppFileSystem.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, AppFileSystem.Error>
  readonly resolve: (
    messages: MessageV2.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], AppFileSystem.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const rawHttp = withTransientReadRetry(yield* HttpClient.HttpClient)
    const http = HttpClient.filterStatusOk(rawHttp)
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = files(flags.disableClaudeCodePrompt)

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string, strict = false) {
      const ctx = yield* InstanceState.context
      if (strict) {
        const matches: string[] = []
        let current = path.resolve(Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? global.config : ctx.directory)
        const stop = path.resolve(Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? global.config : ctx.worktree)
        while (true) {
          matches.push(...(yield* fs.glob(instruction, { cwd: current, absolute: true, include: "file", dot: true })))
          const parent = path.dirname(current)
          if (current === stop || parent === current) break
          current = parent
        }
        return matches
      }
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* (strict = false) {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        const exists = strict
          ? yield* fs.stat(file).pipe(
              Effect.as(true),
              Effect.catchIf(missing, () => Effect.succeed(false)),
            )
          : yield* fs.existsSafe(file)
        if (exists) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* fs
            .findUp(
              file,
              strict ? path.resolve(ctx.directory) : ctx.directory,
              strict ? path.resolve(ctx.worktree) : ctx.worktree,
            )
            .pipe(Effect.catch((error) => (strict ? Effect.fail(error) : Effect.succeed([]))))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction, strict)
          ).pipe(Effect.catch((error) => (strict ? Effect.fail(error) : Effect.succeed([] as string[]))))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      return [
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
    })

    const source = (messages: MessageV2.WithParts[]) =>
      InstructionSource.make({
        key: "core/instructions",
        schema: InstructionGuidance.Files,
        read: (previous) =>
          Effect.gen(function* () {
            const config = yield* cfg.get()
            const ctx = yield* InstanceState.context
            const paths = yield* systemPaths(true)
            const loaded = new Set([
              ...extract(messages),
              ...(previous ?? []).filter((file) => file.loaded).map((file) => file.path),
            ])
            const patterns: string[] = []
            for (const raw of config.instructions ?? []) {
              if (/^https?:\/\//.test(raw)) {
                paths.add(raw)
                continue
              }
              const pattern = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
              if (path.isAbsolute(pattern)) {
                patterns.push(pattern)
                if (!/[?*{}\[\]]/.test(pattern)) paths.add(pattern)
                continue
              }
              let current = path.resolve(Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? global.config : ctx.directory)
              const stop = path.resolve(Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? global.config : ctx.worktree)
              while (true) {
                patterns.push(path.join(current, pattern))
                if (!/[?*{}\[\]]/.test(pattern)) paths.add(path.join(current, pattern))
                const parent = path.dirname(current)
                if (current === stop || parent === current) break
                current = parent
              }
            }
            for (const file of previous ?? [])
              if (
                patterns.some((pattern) =>
                  Glob.match(
                    process.platform === "win32" ? pattern.replaceAll("\\", "/") : pattern,
                    process.platform === "win32" ? file.path.replaceAll("\\", "/") : file.path,
                  ),
                )
              )
                paths.add(file.path)
            for (const file of loaded) paths.add(file)
            const observed = yield* Effect.forEach(
              [...paths],
              (location) =>
                Effect.gen(function* () {
                  log.debug("instruction file read started", {
                    location: location.startsWith("http")
                      ? new URL(location).origin + new URL(location).pathname
                      : location,
                  })
                  const content = yield* /^https?:\/\//.test(location)
                    ? Effect.gen(function* () {
                        const response = yield* rawHttp.execute(HttpClientRequest.get(location))
                        if (response.status === 404 || response.status === 410) return undefined
                        if (response.status < 200 || response.status >= 300)
                          return yield* Effect.fail(new Error(`Instruction HTTP status ${response.status}`))
                        return new TextDecoder().decode(yield* response.arrayBuffer)
                      }).pipe(Effect.timeout(5000))
                    : fs.readFileString(location).pipe(Effect.catchIf(missing, () => Effect.succeed(undefined)))
                  log.debug("instruction file read settled", {
                    present: content !== undefined,
                    chars: content?.length ?? 0,
                  })
                  return content === undefined || content.length === 0
                    ? []
                    : [{ path: location, content, ...(loaded.has(location) ? { loaded: true } : {}) }]
                }),
              { concurrency: 4 },
            )
            return observed.flat()
          }).pipe(
            Effect.catchCause((cause) => {
              log.warn("instruction source unavailable", { cause: String(cause) })
              return Effect.succeed(InstructionSource.unavailable)
            }),
          ),
        initial: InstructionGuidance.renderFiles,
        changed: InstructionGuidance.updateFiles,
      })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: MessageV2.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      return results
    })

    return Service.of({ clear, systemPaths, system, find, resolve, source })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export function loaded(messages: MessageV2.WithParts[]) {
  return extract(messages)
}

export * as Instruction from "./instruction"
