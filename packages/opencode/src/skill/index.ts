import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Schema, Semaphore } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "@/permission"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@opencode-ai/core/util/glob"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { Discovery } from "./discovery"
import USE_OPENCODE_SKILL_BODY from "./prompt/use-opencode.md" with { type: "text" }
import MATH_INITIALIZE_SKILL_BODY from "./prompt/math-initialize.md" with { type: "text" }
import MATH_ELABORATION_SKILL_BODY from "./prompt/math-elaboration.md" with { type: "text" }
import MATH_QUERY_MEMORY_SKILL_BODY from "./prompt/math-query-memory.md" with { type: "text" }
import MATH_WORKER_QUERY_MEMORY_SKILL_BODY from "./prompt/math-worker-query-memory.md" with { type: "text" }
import MATH_WORKER_IMMEDIATE_CONCLUSIONS_SKILL_BODY from "./prompt/math-worker-immediate-conclusions.md" with { type: "text" }
import MATH_WORKER_TOY_EXAMPLES_SKILL_BODY from "./prompt/math-worker-toy-examples.md" with { type: "text" }
import MATH_WORKER_COUNTEREXAMPLES_SKILL_BODY from "./prompt/math-worker-counterexamples.md" with { type: "text" }
import MATH_WORKER_DECOMPOSITION_SKILL_BODY from "./prompt/math-worker-decomposition.md" with { type: "text" }
import MATH_WORKER_DIRECT_PROVING_SKILL_BODY from "./prompt/math-worker-direct-proving.md" with { type: "text" }
import MATH_WORKER_KEY_FAILURES_SKILL_BODY from "./prompt/math-worker-key-failures.md" with { type: "text" }
import MATH_WORKER_SEARCH_RESULTS_SKILL_BODY from "./prompt/math-worker-search-results.md" with { type: "text" }
import MATH_WORKER_VERIFY_PROOF_SKILL_BODY from "./prompt/math-worker-verify-proof.md" with { type: "text" }
import { isRecord } from "@/util/record"

const log = Log.create({ service: "skill" })
const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

// Built-in skill that ships with opencode. The model's intuition for what an
// opencode.json should look like is often wrong, and opencode hard-fails on
// invalid config, so users hit cryptic startup errors. Loading this skill
// when the model is asked to touch opencode's own config files gives it the
// actual schemas instead of guesses.
const USE_OPENCODE_SKILL_NAME = "use-opencode"
const USE_OPENCODE_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, files under the XDG OpenCode config directory, or files under ~/.opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself."
const MATH_SKILLS = [
  {
    name: "math-initialize",
    description: "Initialize or reconnect an OpenCode Math Mode swarm without duplicating durable workers.",
    content: MATH_INITIALIZE_SKILL_BODY,
  },
  {
    name: "math-elaboration",
    description: "Compress Math Mode strategy, verified foundations, worker assignments, and open obligations.",
    content: MATH_ELABORATION_SKILL_BODY,
  },
  {
    name: "math-query-memory",
    description: "Query Math Mode fact graph and global memory while preserving the verified-vs-hypothesis boundary.",
    content: MATH_QUERY_MEMORY_SKILL_BODY,
  },
  {
    name: "query-memory",
    description:
      "Recall worker transcript, shared hypotheses, verifier feedback, and verified facts before new proof work.",
    content: MATH_WORKER_QUERY_MEMORY_SKILL_BODY,
  },
  {
    name: "obtain-immediate-conclusions",
    description: "Derive cheap consequences and identify fragile claims before deeper mathematical search.",
    content: MATH_WORKER_IMMEDIATE_CONCLUSIONS_SKILL_BODY,
  },
  {
    name: "construct-toy-examples",
    description: "Build rigorously checked simple examples to expose mechanisms and proof patterns.",
    content: MATH_WORKER_TOY_EXAMPLES_SKILL_BODY,
  },
  {
    name: "construct-counterexamples",
    description: "Actively falsify fragile conjectures while preserving their assumptions.",
    content: MATH_WORKER_COUNTEREXAMPLES_SKILL_BODY,
  },
  {
    name: "propose-subgoal-decomposition-plans",
    description: "Create materially different ordered subgoal plans informed by current evidence and failures.",
    content: MATH_WORKER_DECOMPOSITION_SKILL_BODY,
  },
  {
    name: "direct-proving",
    description: "Screen one decomposition plan by directly attempting all subgoals and verifying reusable lemmas.",
    content: MATH_WORKER_DIRECT_PROVING_SKILL_BODY,
  },
  {
    name: "identify-key-failures",
    description: "Synthesize recurring failure mechanisms across unsuccessful proof plans.",
    content: MATH_WORKER_KEY_FAILURES_SKILL_BODY,
  },
  {
    name: "search-math-results",
    description: "Retrieve program-conditioned mathematical results, constructions, examples, and analogies.",
    content: MATH_WORKER_SEARCH_RESULTS_SKILL_BODY,
  },
  {
    name: "verify-proof",
    description: "Turn a self-contained proof into a verifier-gated fact through fact_submit.",
    content: MATH_WORKER_VERIFY_PROOF_SKILL_BODY,
  },
] as const

export const MATH_SKILL_NAMES: ReadonlySet<string> = new Set(MATH_SKILLS.map((skill) => skill.name))

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
  available: boolean
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
  available: boolean
  roots: string[]
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
  available: boolean
  roots: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info, options?: { refresh?: boolean }) => Effect.Effect<Info[]>
}

const add = Effect.fnUntraced(function* (state: State, match: string, bus: Bus.Interface) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        state.available = false
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  if (state.skills[md.data.name]) {
    log.warn("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  state.roots.add(root)
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      state.available = false
      if (!opts?.scope) return Effect.die(error)
      log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      return Effect.succeed([] as string[])
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: AppFileSystem.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set(), available: true, roots: new Set() }
  const isDirectory = (location: string) =>
    fsys.stat(location).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.catch((error) => {
        if (error.reason._tag !== "NotFound") {
          state.available = false
          log.warn("skill directory unavailable", { location, error: String(error) })
        }
        return Effect.succeed(false)
      }),
    )
  log.info("discover start", { directory, worktree, disableExternalSkills, disableClaudeCodeSkills })

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* isDirectory(root))) continue
      log.info("discover global root", { root, pattern: EXTERNAL_SKILL_PATTERN })
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys.up({ targets: externalDirs, start: directory, stop: worktree }).pipe(
      Effect.catch((error) => {
        state.available = false
        log.warn("skill ancestry unavailable", { error: String(error) })
        return Effect.succeed([] as string[])
      }),
    )

    for (const root of upDirs) {
      log.info("discover project root", { root, pattern: EXTERNAL_SKILL_PATTERN })
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const cachedDirs = yield* config.directories()
  const freshDirs = Flag.OPENCODE_DISABLE_PROJECT_CONFIG
    ? []
    : yield* fsys.up({ targets: [".opencode"], start: directory, stop: worktree }).pipe(
        Effect.catch((error) => {
          state.available = false
          log.warn("skill config roots unavailable", { error: String(error) })
          return Effect.succeed([] as string[])
        }),
      )
  const configDirs = [...new Set([...cachedDirs, ...freshDirs])]
  for (const dir of configDirs) {
    log.info("discover config root", { root: dir, pattern: OPENCODE_SKILL_PATTERN })
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* isDirectory(dir))) {
      log.warn("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
    available: state.available,
    roots: [...state.roots],
  }
})

const loadSkills = Effect.fnUntraced(function* (state: State, discovered: DiscoveryState, bus: Bus.Interface) {
  state.available = discovered.available
  log.info("load start", { matches: discovered.matches })
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, bus), {
    concurrency: 1,
    discard: true,
  })

  log.info("init", { count: Object.keys(state.skills).length, names: Object.keys(state.skills).toSorted() })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const fsys = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const remote = yield* InstanceState.make(() => Effect.succeed(new Map<string, string[]>()))
    const cachedDiscovery: Discovery.Interface = {
      pull: (url) =>
        Effect.gen(function* () {
          const cache = yield* InstanceState.get(remote)
          const existing = cache.get(url)
          if (existing) return existing
          const dirs = yield* discovery.pull(url)
          cache.set(url, dirs)
          return dirs
        }),
    }
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          cachedDiscovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set(), available: true }
        // Register the built-in skill BEFORE disk discovery so a user-disk
        // skill with the same name can override it.
        s.skills[USE_OPENCODE_SKILL_NAME] = {
          name: USE_OPENCODE_SKILL_NAME,
          description: USE_OPENCODE_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: USE_OPENCODE_SKILL_BODY,
        }
        for (const skill of MATH_SKILLS) {
          s.skills[skill.name] = { ...skill, location: "<built-in>" }
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered), bus)
        return s
      }),
    )

    const refreshLock = yield* InstanceState.make(() => Effect.succeed(Semaphore.makeUnsafe(1)))
    const refresh = Effect.fn("Skill.refresh")(function* () {
      const lock = yield* InstanceState.get(refreshLock)
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const current = yield* InstanceState.get(state)
          log.info("skill refresh started", { directory: ctx.directory })
          const found = yield* discoverSkills(
            config,
            cachedDiscovery,
            fsys,
            global,
            flags.disableExternalSkills,
            flags.disableClaudeCodeSkills,
            ctx.directory,
            ctx.worktree,
          )
          const next: State = {
            skills: {
              [USE_OPENCODE_SKILL_NAME]: {
                name: USE_OPENCODE_SKILL_NAME,
                description: USE_OPENCODE_SKILL_DESCRIPTION,
                location: "<built-in>",
                content: USE_OPENCODE_SKILL_BODY,
              },
            },
            dirs: new Set(),
            available: true,
          }
          for (const skill of MATH_SKILLS) next.skills[skill.name] = { ...skill, location: "<built-in>" }
          yield* loadSkills(next, found, bus)
          const present = new Set(Object.values(next.skills).map((skill) => skill.location))
          for (const skill of Object.values(current.skills))
            if (
              skill.location !== "<built-in>" &&
              found.matches.includes(skill.location) &&
              !present.has(skill.location)
            ) {
              next.available = false
              log.warn("known skill is temporarily invalid", { name: skill.name, location: skill.location })
            }
          for (const skill of Object.values(current.skills)) {
            if (
              skill.location === "<built-in>" ||
              present.has(skill.location) ||
              found.matches.includes(skill.location)
            )
              continue
            const inScope = found.roots.some((root) => {
              const relative = path.relative(root, skill.location)
              return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
            })
            if (!inScope) continue
            const exists = yield* fsys.stat(skill.location).pipe(
              Effect.as(true),
              Effect.catch((error) => {
                if (error.reason._tag !== "NotFound") {
                  next.available = false
                  log.warn("known skill path unavailable", { location: skill.location, error: String(error) })
                }
                return Effect.succeed(false)
              }),
            )
            if (exists) {
              next.available = false
              log.warn("skill scan omitted an existing known file", { location: skill.location })
            }
          }
          if (!next.available) {
            log.warn("skill refresh unavailable; keeping cached state", { directory: ctx.directory })
            return yield* Effect.die(new Error("Skill discovery is temporarily unavailable"))
          }
          current.skills = next.skills
          current.dirs = next.dirs
          current.available = true
          log.info("skill refresh completed", { directory: ctx.directory, count: Object.keys(next.skills).length })
        }),
      )
    })

    // Math Mode can be switched off at runtime (config.math.disabled), so the
    // built-in math skills are filtered when serving lists/lookups instead of
    // being dropped from the cached state.
    const mathDisabled = Effect.fn("Skill.mathDisabled")(function* () {
      const cfg = yield* config.get()
      return cfg.math?.disabled === true
    })

    const visible = Effect.fn("Skill.visible")(function* () {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills)
      if (!(yield* mathDisabled())) return list
      log.info("math mode disabled, hiding built-in math skills")
      return list.filter((skill) => !MATH_SKILL_NAMES.has(skill.name))
    })

    const get = Effect.fn("Skill.get")(function* (name: string) {
      if (MATH_SKILL_NAMES.has(name) && (yield* mathDisabled())) return undefined
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const info = yield* get(name)
      if (info) return info
      const list = (yield* visible()).map((skill) => skill.name)
      return yield* new NotFoundError({ name, available: list })
    })

    const all = Effect.fn("Skill.all")(function* () {
      return yield* visible()
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info, options?: { refresh?: boolean }) {
      if (options?.refresh) yield* refresh()
      const list = (yield* visible()).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, require, all, dirs, available })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export * as Skill from "."
