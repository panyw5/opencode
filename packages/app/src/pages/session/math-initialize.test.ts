import { describe, expect, test } from "bun:test"
import {
  buildMathInitializationPrompt,
  createMathProblemID,
  defaultMathProjectName,
  validMathProjectName,
} from "./math-initialize"

describe("math initialization", () => {
  test("normalizes a workspace name into a valid problem project", () => {
    expect(defaultMathProjectName("/tmp/Brocard Research")).toBe("brocard-research")
    expect(validMathProjectName("brocard-conjecture")).toBe(true)
    expect(validMathProjectName("invalid project")).toBe(false)
  })

  test("builds a bounded confirmed roster prompt", () => {
    const prompt = buildMathInitializationPrompt({
      project: "brocard-conjecture",
      problem: "Does n! + 1 = m^2 have further positive integer solutions?",
      workerModel: "test/prover",
      verifierModel: "test/verifier",
      highWorkers: 1,
      xhighWorkers: 2,
      controlBeat: false,
    })
    expect(prompt).toContain("Use the math-initialize skill")
    expect(prompt).toContain("Math problem ID: brocard-conjecture")
    expect(prompt).toContain("Use brocard-conjecture as the project argument for every math worker tool call")
    expect(prompt).toContain("bounded roster of 3 workers")
    expect(prompt).toContain("1 worker with variant high and 2 workers with variant xhigh")
    expect(prompt).toContain("Use worker model test/prover")
    expect(prompt).toContain("verifier_model=test/verifier")
    expect(prompt).toContain("Do not create a scheduled control beat")
  })

  test("creates a distinct stable-format workspace ID for each initialization", () => {
    expect(createMathProblemID("Does n! + 1 = m^2?", "12345678-abcd-4abc-9000-123456789abc")).toBe(
      "does-n-1-m-2-12345678abcd",
    )
    expect(createMathProblemID("同余问题", "aaaaaaaa-bbbb-4ccc-8000-dddddddddddd")).toBe(
      "problem-aaaaaaaabbbb",
    )
  })

  test("uses singular worker grammar for a one-worker roster", () => {
    const prompt = buildMathInitializationPrompt({
      project: "single-worker",
      problem: "Prove a bounded lemma.",
      workerModel: "test/prover",
      verifierModel: "test/verifier",
      highWorkers: 1,
      xhighWorkers: 0,
      controlBeat: false,
    })
    expect(prompt).toContain("bounded roster of 1 worker: 1 worker with variant high")
  })
})
