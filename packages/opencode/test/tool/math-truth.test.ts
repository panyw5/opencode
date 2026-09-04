import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { FactGraph } from "@/math/fact-graph"
import { GlobalMemory } from "@/math/global-memory"
import { mathRoot } from "@/math/layout"
import { writeProblemStatement } from "@/math/problem"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import {
  MathFactGetTool,
  MathFactRevokeTool,
  MathFactSearchTool,
  MathGmAddTool,
  MathGmSearchTool,
} from "@/tool/math-truth"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, Session.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

const setup = Effect.fn("MathTruthToolTest.setup")(function* () {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ title: "Math", agent: "math-orchestrator" })
  const project = "native-tools"
  const projectDir = mathRoot(parent.directory, project)
  writeProblemStatement(
    projectDir,
    `Prove the following fully specified statement. ${"All notation is fixed here. ".repeat(10)}`,
  )
  const requests: Parameters<Tool.Context["ask"]>[0][] = []
  const ctx = {
    sessionID: parent.id,
    messageID: MessageID.ascending(),
    agent: "math-orchestrator",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        requests.push(request)
      }),
  } satisfies Tool.Context
  return { parent, project, projectDir, requests, ctx }
})

describe("tool.math-truth", () => {
  it.instance("lets the orchestrator coordinate memory and inspect facts without submitting them", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const gmAdd = yield* (yield* MathGmAddTool).init()
      const gmSearch = yield* (yield* MathGmSearchTool).init()
      const factSearch = yield* (yield* MathFactSearchTool).init()
      const factGet = yield* (yield* MathFactGetTool).init()
      const factRevoke = yield* (yield* MathFactRevokeTool).init()

      yield* gmAdd.execute(
        {
          project: input.project,
          kind: "master_guidance",
          claim: "Pursue the bridge lemma",
          evidence: "The current verified foundation isolates this bridge.",
        },
        input.ctx,
      )
      const memory = yield* gmSearch.execute({ project: input.project, query: "bridge lemma" }, input.ctx)
      expect(memory.output).toContain("Pursue the bridge lemma")
      const guidance = yield* Effect.promise(() => new GlobalMemory(input.projectDir).read("master_guidance"))
      expect(guidance[0]?.author).toBe(input.parent.id)

      const factID = yield* Effect.promise(() =>
        new FactGraph(input.projectDir).add({
          problem_id: input.project,
          author: "worker",
          statement: "The bridge lemma holds.",
          proof: "A complete verified proof.",
        }),
      )
      const search = yield* factSearch.execute({ project: input.project, query: "bridge lemma" }, input.ctx)
      expect(search.output).toContain(factID)
      const get = yield* factGet.execute({ project: input.project, fact_id: factID }, input.ctx)
      expect(get.output).toContain("complete verified proof")
      const revoked = yield* factRevoke.execute(
        { project: input.project, fact_id: factID, reason: "Invalid premise discovered" },
        input.ctx,
      )
      expect(JSON.parse(revoked.output).revoked).toEqual([factID])
      expect(input.requests.map((request) => request.permission)).toEqual([
        "math_gm_add",
        "math_gm_search",
        "math_fact_search",
        "math_fact_get",
        "math_fact_revoke",
      ])
    }),
  )
})
