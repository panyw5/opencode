import { describe, expect, test } from "bun:test"
import {
  buildVerifierPrompt,
  decodeVerifyResult,
  parseVerifierText,
  sessionVerifier,
  VerifyUnavailableError,
} from "../../src/math/verifier"

const input = {
  problem_id: "P",
  statement: "B",
  proof: "B follows from A",
  predecessors: ["abc"],
  predecessor_facts: [{ fact_id: "abc", content: "A is verified" }],
  glossary: { A: "a proposition" },
}

describe("math.verifier", () => {
  test("accepts correct exactly when errors and gaps are empty", () => {
    expect(
      decodeVerifyResult({
        verdict: "correct",
        verification_report: { summary: "checked", critical_errors: [], gaps: [] },
      }),
    ).toEqual({
      verdict: "correct",
      repair_hints: undefined,
      verification_report: { summary: "checked", critical_errors: [], gaps: [] },
    })
  })

  test("accepts wrong with a reported gap", () => {
    expect(
      decodeVerifyResult({
        verdict: "wrong",
        repair_hints: "prove step 2",
        verification_report: { summary: "gap", critical_errors: [], gaps: ["step 2 is unsupported"] },
      }).verdict,
    ).toBe("wrong")
  })

  test("rejects an inconsistent or incomplete verifier response", () => {
    expect(() =>
      decodeVerifyResult({
        verdict: "correct",
        verification_report: { summary: "not actually checked", critical_errors: [], gaps: ["missing case"] },
      }),
    ).toThrow(VerifyUnavailableError)
    expect(() => decodeVerifyResult({ verdict: "correct" })).toThrow(VerifyUnavailableError)
  })

  test("cold session verifier decodes subprocess structured output", async () => {
    const verifier = sessionVerifier({
      workspace: process.cwd(),
      run: async () =>
        JSON.stringify({
          verdict: "correct",
          verification_report: { summary: "checked", critical_errors: [], gaps: [] },
        }),
    })
    expect((await verifier.verify(input)).verdict).toBe("correct")
  })

  test("prompt includes predecessor facts and zero-gap contract", () => {
    const prompt = buildVerifierPrompt(input)
    expect(prompt).toContain("zero critical errors and zero logical gaps")
    expect(prompt).toContain("A is verified")
    expect(prompt).toContain('"glossary"')
  })

  test("plain-text transport requires a bare strict JSON object", () => {
    const json = JSON.stringify({
      verdict: "correct",
      verification_report: { summary: "checked", critical_errors: [], gaps: [] },
    })
    expect(parseVerifierText(json).verdict).toBe("correct")
    expect(() => parseVerifierText(`\`\`\`json\n${json}\n\`\`\``)).toThrow(VerifyUnavailableError)
  })
})
