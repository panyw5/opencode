import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "@/session/session"
import { mathRoot } from "@/math/layout"
import { ensureProblemStatementReady } from "@/math/problem"
import { GlobalMemory } from "@/math/global-memory"
import { FactGraph } from "@/math/fact-graph"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.math-truth" })

const Project = Schema.String.annotate({
  description: "Math problem ID under .math/problems/. Always name the project explicitly.",
})

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const GmAddParameters = Schema.Struct({
  project: Project,
  kind: Schema.String.annotate({ description: "Global-memory kind, such as elaboration or master_guidance" }),
  claim: Schema.String.annotate({ description: "The finding or strategic judgment" }),
  evidence: Schema.optional(Schema.String).annotate({ description: "Supporting proof, construction, or reasoning" }),
  verifiable: Schema.optional(Schema.Boolean),
  glossary: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  links: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const GmSearchParameters = Schema.Struct({
  project: Project,
  query: Schema.String,
  kinds: Schema.optional(Schema.Array(Schema.String)),
  limit_per_kind: Schema.optional(PositiveInt),
})

const FactSearchParameters = Schema.Struct({
  project: Project,
  query: Schema.String,
  limit: Schema.optional(PositiveInt),
})

const FactGetParameters = Schema.Struct({
  project: Project,
  fact_id: Schema.String,
})

const FactRevokeParameters = Schema.Struct({
  project: Project,
  fact_id: Schema.String,
  reason: Schema.String.annotate({ description: "Why this fact and all descendants must be revoked" }),
})

const resolveProject = Effect.fnUntraced(function* (sessions: Session.Interface, project: string, ctx: Tool.Context) {
  const parent = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
  const projectDir = mathRoot(parent.directory, project)
  ensureProblemStatementReady(projectDir)
  return { projectDir, author: parent.id }
})

export const MathGmAddTool = Tool.define(
  "math_gm_add",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "Publish orchestrator strategy or a finding to a Math Mode project's shared global memory. This is awareness, never a proof brick. Verifiable kinds require evidence.",
      parameters: GmAddParameters,
      execute: (params: Schema.Schema.Type<typeof GmAddParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "math_gm_add",
            patterns: [params.project],
            always: ["*"],
            metadata: { project: params.project, kind: params.kind },
          })
          log.info("math global memory add start", {
            project: params.project,
            kind: params.kind,
            sessionID: ctx.sessionID,
          })
          const resolved = yield* resolveProject(sessions, params.project, ctx)
          const id = yield* Effect.promise(() =>
            new GlobalMemory(resolved.projectDir).append({
              kind: params.kind,
              claim: params.claim,
              evidence: params.evidence ?? "",
              author: resolved.author,
              verifiable: params.verifiable,
              glossary: params.glossary,
              links: params.links,
            }),
          )
          const result = { id, kind: params.kind, project: params.project }
          log.info("math global memory add finish", { project: params.project, kind: params.kind, id })
          return { title: `math memory ${id}`, output: JSON.stringify(result), metadata: result }
        }),
    }
  }),
)

export const MathGmSearchTool = Tool.define(
  "math_gm_search",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "Search a Math Mode project's shared global-memory findings with BM25. Results are hypotheses or strategy, never verified proof bricks.",
      parameters: GmSearchParameters,
      execute: (params: Schema.Schema.Type<typeof GmSearchParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "math_gm_search",
            patterns: [params.project],
            always: ["*"],
            metadata: { project: params.project },
          })
          log.info("math global memory search start", { project: params.project, sessionID: ctx.sessionID })
          const resolved = yield* resolveProject(sessions, params.project, ctx)
          const result = yield* Effect.promise(() =>
            new GlobalMemory(resolved.projectDir).search(
              params.query,
              params.kinds ? [...params.kinds] : undefined,
              params.limit_per_kind ?? 10,
            ),
          )
          log.info("math global memory search finish", {
            project: params.project,
            kinds: Object.keys(result.results_by_kind).length,
          })
          return { title: `math memory search ${params.project}`, output: JSON.stringify(result), metadata: result }
        }),
    }
  }),
)

export const MathFactSearchTool = Tool.define(
  "math_fact_search",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "Search verifier-accepted facts in a Math Mode project. Only returned fact_id values may be used as proof bricks.",
      parameters: FactSearchParameters,
      execute: (params: Schema.Schema.Type<typeof FactSearchParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "math_fact_search",
            patterns: [params.project],
            always: ["*"],
            metadata: { project: params.project },
          })
          log.info("math fact search start", { project: params.project, sessionID: ctx.sessionID })
          const resolved = yield* resolveProject(sessions, params.project, ctx)
          const results = yield* Effect.promise(() =>
            new FactGraph(resolved.projectDir).search(params.query, params.limit ?? 10),
          )
          const result = { query: params.query, results }
          log.info("math fact search finish", { project: params.project, results: results.length })
          return { title: `math fact search ${params.project}`, output: JSON.stringify(result), metadata: result }
        }),
    }
  }),
)

export const MathFactGetTool = Tool.define(
  "math_fact_get",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description: "Read one active verifier-accepted fact by exact fact_id after math_fact_search surfaces it.",
      parameters: FactGetParameters,
      execute: (params: Schema.Schema.Type<typeof FactGetParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "math_fact_get",
            patterns: [`${params.project}/${params.fact_id}`],
            always: ["*"],
            metadata: { project: params.project, factID: params.fact_id },
          })
          log.info("math fact get start", { project: params.project, factID: params.fact_id, sessionID: ctx.sessionID })
          const resolved = yield* resolveProject(sessions, params.project, ctx)
          const content = yield* Effect.promise(() => new FactGraph(resolved.projectDir).getRaw(params.fact_id))
          if (!content) throw new Error(`unknown fact_id: ${params.fact_id}`)
          const result = { fact_id: params.fact_id, content }
          log.info("math fact get finish", { project: params.project, factID: params.fact_id })
          return { title: `math fact ${params.fact_id}`, output: JSON.stringify(result), metadata: result }
        }),
    }
  }),
)

export const MathFactRevokeTool = Tool.define(
  "math_fact_revoke",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "Cascade-revoke one verifier-accepted fact and every descendant. Use only after identifying a genuinely invalid fact; this is destructive and cannot submit replacement facts.",
      parameters: FactRevokeParameters,
      execute: (params: Schema.Schema.Type<typeof FactRevokeParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "math_fact_revoke",
            patterns: [`${params.project}/${params.fact_id}`],
            always: ["*"],
            metadata: { project: params.project, factID: params.fact_id },
          })
          log.info("math fact revoke start", {
            project: params.project,
            factID: params.fact_id,
            sessionID: ctx.sessionID,
          })
          const resolved = yield* resolveProject(sessions, params.project, ctx)
          const revoked = yield* Effect.promise(() =>
            new FactGraph(resolved.projectDir).revoke(params.fact_id, params.reason),
          )
          const result = { revoked }
          log.info("math fact revoke finish", {
            project: params.project,
            factID: params.fact_id,
            revoked: revoked.length,
          })
          return { title: `revoked ${revoked.length} math fact(s)`, output: JSON.stringify(result), metadata: result }
        }),
    }
  }),
)
