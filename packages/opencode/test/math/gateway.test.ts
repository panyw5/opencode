import { describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import path from "path"
import { FactGraph } from "../../src/math/fact-graph"
import { createGateway, ToolNotFoundError } from "../../src/math/gateway"
import { GlobalMemory } from "../../src/math/global-memory"
import { toolsFor } from "../../src/math/roles"
import { missingVerifier, stubVerifier } from "../../src/math/verifier"
import { tmpdir } from "../fixture/fixture"

describe("math.roles", () => {
  test("orchestrator / main never see fact_submit; unknown fails closed", () => {
    expect(toolsFor("orchestrator")).not.toContain("fact_submit")
    expect(toolsFor("main")).not.toContain("fact_submit")
    expect(toolsFor("orchestrator")).toContain("fact_revoke")
    expect(toolsFor("worker")).toContain("fact_submit")
    expect(toolsFor("verifier")).toEqual([])
    expect(toolsFor("nope")).toEqual(toolsFor("verifier"))
    expect(toolsFor(undefined)).toEqual(toolsFor("verifier"))
    expect(toolsFor("all")).toContain("fact_submit")
  })
})

describe("math.gateway", () => {
  test("orchestrator calling fact_submit is tool-not-found", async () => {
    await using tmp = await tmpdir()
    const gw = createGateway({
      projectDir: tmp.path,
      role: "orchestrator",
      author: "main",
      problemId: "P",
      verifier: stubVerifier(() => ({ verdict: "correct" })),
    })
    expect(gw.tools()).not.toContain("fact_submit")
    expect(gw.has("fact_submit")).toBe(false)
    await expect(gw.call("fact_submit", { statement: "S", proof: "pf" })).rejects.toBeInstanceOf(ToolNotFoundError)
    expect(await new FactGraph(tmp.path).list()).toEqual([])
  })

  test("correct verdict writes a fact and a verification trace", async () => {
    await using tmp = await tmpdir()
    const gw = createGateway({
      projectDir: tmp.path,
      role: "worker",
      author: "worker_high",
      problemId: "P",
      verifier: stubVerifier(() => ({ verdict: "correct", verification_report: { summary: "ok" } })),
    })
    const res = (await gw.call("fact_submit", { statement: "S(n)=n^2", proof: "induction; QED" })) as {
      accepted: boolean
      fact_id: string
    }
    expect(res.accepted).toBe(true)
    expect(res.fact_id).toBeTruthy()
    expect(await new FactGraph(tmp.path).exists(res.fact_id)).toBe(true)
    const traces = await new GlobalMemory(tmp.path).read("verification")
    expect(traces.at(-1)?.verdict).toBe("correct")
    expect(traces.at(-1)?.fact_id).toBe(res.fact_id)
  })

  test("wrong verdict writes no fact but still traces", async () => {
    await using tmp = await tmpdir()
    const gw = createGateway({
      projectDir: tmp.path,
      role: "worker",
      author: "worker_high",
      problemId: "P",
      verifier: stubVerifier(() => ({ verdict: "wrong", repair_hints: "gap in step 2" })),
    })
    const res = (await gw.call("fact_submit", { statement: "bad", proof: "hand-wave" })) as {
      accepted: boolean
      repair_hints?: string
    }
    expect(res.accepted).toBe(false)
    expect(res.repair_hints).toBe("gap in step 2")
    expect(await new FactGraph(tmp.path).list()).toEqual([])
    expect(existsSync(path.join(tmp.path, "fact_graph", "facts"))).toBe(false)
    expect((await new GlobalMemory(tmp.path).read("verification")).at(-1)?.verdict).toBe("wrong")
  })

  test("missing verifier writes no fact and records the system error", async () => {
    await using tmp = await tmpdir()
    const gw = createGateway({
      projectDir: tmp.path,
      role: "worker",
      author: "w",
      problemId: "P",
      verifier: missingVerifier("service down"),
    })
    const res = (await gw.call("fact_submit", { statement: "s", proof: "p" })) as {
      accepted: boolean
      verdict: string
      error: string
    }
    expect(res.accepted).toBe(false)
    expect(res.verdict).toBe("error")
    expect(res.error).toContain("service down")
    expect(await new FactGraph(tmp.path).list()).toEqual([])
    expect((await new GlobalMemory(tmp.path).read("verification")).at(-1)).toMatchObject({
      claim: "s",
      verdict: "error",
      error: "service down",
    })
  })

  test("accepted-but-revoked-predecessor still traces", async () => {
    await using tmp = await tmpdir()
    const fg = new FactGraph(tmp.path)
    const base = await fg.add({ problem_id: "P", author: "w", statement: "A holds", proof: "pf A" })
    await fg.revoke(base, "A was wrong")
    const gw = createGateway({
      projectDir: tmp.path,
      role: "worker",
      author: "worker_high",
      problemId: "P",
      verifier: stubVerifier(() => ({ verdict: "correct" })),
    })
    const res = (await gw.call("fact_submit", {
      statement: "B from A",
      proof: "uses A",
      predecessors: [base],
    })) as { accepted: boolean; fact_id: null; write_error: string }
    expect(res.accepted).toBe(true)
    expect(res.fact_id).toBeNull()
    expect(res.write_error).toContain("predecessor_revoked")
    expect((await new GlobalMemory(tmp.path).read("verification")).at(-1)?.verdict).toBe("correct")
  })

  test("gm_search and fact_search return top-k not the whole store", async () => {
    await using tmp = await tmpdir()
    const gw = createGateway({
      projectDir: tmp.path,
      role: "orchestrator",
      author: "main",
      problemId: "P",
      verifier: missingVerifier(),
    })
    await gw.call("gm_add", { kind: "plan", claim: "reduce to q>=2", evidence: "" })
    const hits = (await gw.call("gm_search", { query: "reduce", kinds: ["plan"] })) as {
      results_by_kind: { plan: { count: number } }
    }
    expect(hits.results_by_kind.plan.count).toBe(1)
    const facts = (await gw.call("fact_search", { query: "anything" })) as { results: unknown[] }
    expect(facts.results).toEqual([])
  })

  test("verifier role has no write tools", async () => {
    await using tmp = await tmpdir()
    const gw = createGateway({
      projectDir: tmp.path,
      role: "verifier",
      author: "v",
      problemId: "P",
      verifier: missingVerifier(),
    })
    expect(gw.tools()).toEqual([])
    await expect(gw.call("gm_add", { kind: "plan", claim: "x", evidence: "" })).rejects.toBeInstanceOf(ToolNotFoundError)
    await expect(gw.call("fact_submit", { statement: "s", proof: "p" })).rejects.toBeInstanceOf(ToolNotFoundError)
  })
})
