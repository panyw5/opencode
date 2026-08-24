import { describe, expect, test } from "bun:test"
import { GlobalMemory } from "../../src/math/global-memory"
import { tmpdir } from "../fixture/fixture"

describe("math.global-memory", () => {
  test("kind/evidence rules, status fold-in, BM25 top-k", async () => {
    await using tmp = await tmpdir()
    const gm = new GlobalMemory(tmp.path)

    const pid = await gm.append({ kind: "plan", claim: "reduce to the q>=2 case", evidence: "", author: "worker_high" })
    expect((await gm.read("plan")).find((e) => e.id === pid)?.status).toBe("open")

    await gm.append({
      kind: "master_guidance",
      claim: "prioritize the symplectic-rank route",
      evidence: "pro: the rank obstruction is the crux",
      author: "orchestrator",
    })
    await gm.append({
      kind: "elaboration",
      claim: "**Not solved.** Main blocker: rank obstruction",
      evidence: "## 0. Mathematical verdict\n**Not solved.**",
      author: "orchestrator",
      links: { fact_ids: ["abc123"] },
    })
    await gm.append({
      kind: "verification",
      claim: "Lemma L fails for n=2",
      evidence: "verdict: correct",
      author: "worker_xhigh",
      extra: { verdict: "correct", fact_id: "abc123" },
    })

    await expect(gm.append({ kind: "conclusion", claim: "c", evidence: "", author: "w" })).rejects.toThrow("requires explicit evidence")
    await expect(gm.append({ kind: "bogus_kind", claim: "c", evidence: "e", author: "w" })).rejects.toThrow("unknown kind")
    await expect(gm.setStatus("someid", "not-a-status")).rejects.toThrow("invalid status")

    const gid = await gm.append({
      kind: "counterexample",
      claim: "Lemma L fails for n=2",
      evidence: "Take X=P^1; ... QED.",
      author: "worker_xhigh",
    })
    expect((await gm.read("counterexample")).find((e) => e.id === gid)?.status).toBe("unverified")
    await gm.setStatus(gid, "verified", "abc123")
    const entry = (await gm.read("counterexample")).find((e) => e.id === gid)
    expect(entry?.status).toBe("verified")
    expect(entry?.fact_id).toBe("abc123")

    for (let i = 0; i < 3; i++) {
      await gm.append({ kind: "plan", claim: `reduce to q>=${i} case`, evidence: "", author: "w" })
    }
    const first = (await gm.read("plan"))[0].id
    await gm.setStatus(first, "supported")
    const res = await gm.search("reduce", ["plan"], 2)
    expect(res.results_by_kind.plan.count).toBe(2)
    const folded = res.results_by_kind.plan.results.find((h) => h.entry.id === first)
    if (folded) expect(folded.entry.status).toBe("supported")
    expect((await gm.search("zzzquarkxyz", ["plan"])).results_by_kind.plan.count).toBe(0)
  })
})
