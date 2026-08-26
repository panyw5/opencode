import { describe, expect, test } from "bun:test"
import { buildMathInitializationPrompt, defaultMathProjectName, validMathProjectName } from "./math-initialize"

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
      highWorkers: 1,
      xhighWorkers: 2,
      controlBeat: false,
    })
    expect(prompt).toContain("Use the math-initialize skill")
    expect(prompt).toContain("Math project: brocard-conjecture")
    expect(prompt).toContain("bounded roster of 3 workers")
    expect(prompt).toContain("1 worker with variant high and 2 workers with variant xhigh")
    expect(prompt).toContain("Use worker model test/prover")
    expect(prompt).toContain("Do not create a scheduled control beat")
  })

  test("uses singular worker grammar for a one-worker roster", () => {
    const prompt = buildMathInitializationPrompt({
      project: "single-worker",
      problem: "Prove a bounded lemma.",
      workerModel: "test/prover",
      highWorkers: 1,
      xhighWorkers: 0,
      controlBeat: false,
    })
    expect(prompt).toContain("bounded roster of 1 worker: 1 worker with variant high")
  })
})
