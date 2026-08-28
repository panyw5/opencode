import { describe, expect, test } from "bun:test"
import {
  attachVerificationProofs,
  parseFactDetail,
  readMathDetailPage,
  type MathDetailPage,
} from "../../src/math/details"
import { FactGraph } from "../../src/math/fact-graph"
import { GlobalMemory } from "../../src/math/global-memory"
import { tmpdir } from "../fixture/fixture"

describe("math.details", () => {
  test("lists full facts and categorized verification reports", async () => {
    await using tmp = await tmpdir()
    const facts = new FactGraph(tmp.path)
    const memory = new GlobalMemory(tmp.path)
    const factId = await facts.add({
      problem_id: "P",
      author: "worker-1",
      statement: "A implies B",
      proof: "Assume A. Therefore B.",
      intuition: "Follow the implication.",
      glossary_introduces: { A: "the assumption" },
    })
    await memory.append({
      kind: "verification",
      claim: "A implies B",
      evidence: "verdict: correct",
      author: "worker-1",
      verifiable: false,
      extra: {
        verdict: "correct",
        fact_id: factId,
        verification_report: { summary: "Valid", critical_errors: [], gaps: [] },
      },
    })
    await memory.append({
      kind: "verification",
      claim: "C implies D",
      evidence: "Step 2 is unsupported",
      author: "worker-2",
      verifiable: false,
      extra: {
        verdict: "wrong",
        verification_report: {
          summary: "Rejected",
          critical_errors: ["Unsupported inference"],
          gaps: ["Prove step 2"],
        },
      },
    })
    await memory.append({
      kind: "verification",
      claim: "legacy record",
      evidence: "invalid verifier output",
      author: "worker-3",
      verifiable: false,
      extra: { verdict: "legacy-error", error: "invalid JSON" },
    })

    const factPage = await readMathDetailPage({ projectDir: tmp.path, kind: "facts", offset: 0, limit: 20 })
    expect(factPage.total).toBe(1)
    expect(factPage.items[0]).toMatchObject({
      kind: "fact",
      factId,
      statement: "A implies B",
      proof: "Assume A. Therefore B.",
      intuition: "Follow the implication.",
      glossaryIntroduces: { A: "the assumption" },
    })

    const correct = await readMathDetailPage({ projectDir: tmp.path, kind: "correct", offset: 0, limit: 20 })
    expect(correct.items[0]).toMatchObject({ kind: "correct", factId, proof: "Assume A. Therefore B." })

    const wrong = await readMathDetailPage({ projectDir: tmp.path, kind: "wrong", offset: 0, limit: 20 })
    expect(wrong.items[0]).toMatchObject({
      kind: "wrong",
      workerSessionID: "worker-2",
      report: { summary: "Rejected", criticalErrors: ["Unsupported inference"], gaps: ["Prove step 2"] },
    })

    const error = await readMathDetailPage({ projectDir: tmp.path, kind: "error", offset: 0, limit: 20 })
    expect(error.items[0]).toMatchObject({ kind: "error", error: "invalid JSON" })
  })

  test("parses multiline proof sections and attaches transcript proofs", () => {
    const fact = parseFactDetail(
      "fact-1",
      [
        "---",
        "fact_id: fact-1",
        "problem_id: P",
        "author: worker-1",
        "predecessors: []",
        "glossary_introduces: {}",
        "external_refs: []",
        "---",
        "",
        "## statement",
        "A holds",
        "",
        "## proof",
        "First line.",
        "Second line.",
      ].join("\n"),
    )
    expect(fact.proof).toBe("First line.\nSecond line.")

    const page: MathDetailPage = {
      kind: "wrong",
      total: 1,
      offset: 0,
      limit: 20,
      items: [
        {
          kind: "wrong",
          id: "verification-1",
          timestamp: new Date().toISOString(),
          workerSessionID: "worker-1",
          statement: "A holds",
          evidence: "rejected",
        },
      ],
    }
    expect(
      attachVerificationProofs(page, [
        {
          workerSessionID: "worker-1",
          statement: "A holds",
          proof: "Attempted proof",
          verdict: "wrong",
          timestamp: Date.now(),
        },
      ]).items[0],
    ).toMatchObject({ proof: "Attempted proof" })
  })
})
