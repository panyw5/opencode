import { describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import path from "path"
import { computeFactId } from "../../src/math/schema"
import { FactGraph, parseFrontmatter, statementOf } from "../../src/math/fact-graph"
import { tmpdir } from "../fixture/fixture"

describe("math.fact-graph", () => {
  test("content addressing, DAG, search top-k, cascade revoke", async () => {
    await using tmp = await tmpdir()
    const fg = new FactGraph(tmp.path)

    const base = await fg.add({
      problem_id: "P",
      author: "P_high",
      statement: "A holds",
      proof: "proof of A",
      glossary_introduces: { X: "a complex manifold" },
    })
    expect(base).toBe(
      computeFactId({
        problem_id: "P",
        predecessors: [],
        glossary_introduces: { X: "a complex manifold" },
        statement: "A holds",
        proof: "proof of A",
      }),
    )
    expect(base).toBe("82b23055ad205955")

    const child = await fg.add({
      problem_id: "P",
      author: "P_high",
      statement: "B from A",
      proof: "uses A",
      predecessors: [base],
    })
    const grand = await fg.add({
      problem_id: "P",
      author: "P_high",
      statement: "C from B",
      proof: "uses B",
      predecessors: [child],
    })

    expect(await fg.predecessors(child)).toEqual([base])
    expect(new Set(await fg.descendants(base))).toEqual(new Set([child, grand]))
    const raw = await fg.getRaw(base)
    expect(raw).toContain("## statement")
    expect(raw).toContain("## proof")
    expect(parseFrontmatter(raw!).glossary_introduces).toEqual({ X: "a complex manifold" })
    expect((await fg.glossary()).X).toBe("a complex manifold")

    const hits = await fg.search("B from A")
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].fact_id).toBe(child)
    expect(hits[0].statement).toBe("B from A")
    expect(hits.every((h) => h.score > 0)).toBe(true)
    expect(await fg.search("nonexistent symplectic quark")).toEqual([])

    await fg.add({ problem_id: "P", author: "w", statement: "B one", proof: "about B" })
    await fg.add({ problem_id: "P", author: "w", statement: "B two", proof: "about B" })
    await fg.add({ problem_id: "P", author: "w", statement: "B three", proof: "about B" })
    expect((await fg.search("B", 2)).length).toBe(2)

    const revoked = await fg.revoke(base, "A was wrong")
    expect(new Set(revoked)).toEqual(new Set([base, child, grand]))
    expect(await fg.exists(base)).toBe(false)
    expect(existsSync(path.join(tmp.path, "fact_graph", "_revoked", `${base}.md`))).toBe(true)

    await expect(
      fg.add({
        problem_id: "P",
        author: "P_high",
        statement: "D from A",
        proof: "uses A",
        predecessors: [base],
      }),
    ).rejects.toThrow("predecessor_revoked")
  })

  test("identical content is idempotent (same id, same file)", async () => {
    await using tmp = await tmpdir()
    const fg = new FactGraph(tmp.path)
    const a = await fg.add({ problem_id: "P", author: "w", statement: "S", proof: "pf" })
    const b = await fg.add({ problem_id: "P", author: "other", statement: "S", proof: "pf" })
    expect(a).toBe(b)
    expect(await fg.list()).toEqual([a])
  })

  test("revoke of unknown fact_id throws", async () => {
    await using tmp = await tmpdir()
    const fg = new FactGraph(tmp.path)
    await expect(fg.revoke("deadbeefdeadbeef", "nope")).rejects.toThrow("unknown fact_id")
  })

  test("statementOf stops at the next heading", () => {
    expect(statementOf("## statement\nA holds\nand more\n\n## proof\nirrelevant\n")).toBe("A holds and more")
  })

  test("external_refs is mutable metadata and does not change fact_id", async () => {
    await using tmp = await tmpdir()
    const fg = new FactGraph(tmp.path)
    const fid = await fg.add({
      problem_id: "P",
      author: "w",
      statement: "A holds",
      proof: "pf",
      external_refs: [{ key: "HL26", title: "On X" }],
    })
    const again = await fg.add({ problem_id: "P", author: "w", statement: "A holds", proof: "pf" })
    expect(fid).toBe(again)
    const refs = await fg.setExternalRefs(fid, [{ key: "K1", title: "T1" }])
    expect(refs).toEqual([{ key: "K1", title: "T1" }])
    expect(await fg.externalRefs(fid)).toEqual([{ key: "K1", title: "T1" }])
  })

  test("corrupt glossary.json yields {}", async () => {
    await using tmp = await tmpdir()
    const fg = new FactGraph(tmp.path)
    await Bun.write(path.join(tmp.path, "fact_graph", "glossary.json"), "{not json")
    expect(await fg.glossary()).toEqual({})
  })
})
