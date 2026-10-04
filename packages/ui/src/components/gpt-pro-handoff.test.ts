import { describe, expect, test } from "bun:test"
import { handoffGptPro } from "./gpt-pro-handoff"
import type { GptProCommand, GptProJob, GptProPhase } from "@opencode-ai/util/gpt-pro"

function fixture(phase: GptProPhase, race = false) {
  const calls: GptProCommand[] = []
  let current = phase
  const client = {
    command: async (input: GptProCommand) => {
      calls.push(input)
      if (input.action === "pause") {
        if (race) {
          current = "completed"
          throw Error("Already finished")
        }
        current = "paused"
      }
      return { id: "consultation", phase: current } as GptProJob
    },
  }
  return { client, calls }
}

describe("direct gpt-pro browser intervention", () => {
  test("completed conversations open the browser without pausing or resending", async () => {
    const f = fixture("completed")
    expect((await handoffGptPro(f.client, "consultation")).phase).toBe("completed")
    expect(f.calls.map((call) => call.action)).toEqual(["status", "open"])
    expect(f.calls.every((call) => call.prompt === undefined)).toBe(true)
  })
  test("active conversations pause tracking and hand over the existing browser", async () => {
    for (const phase of ["preparing", "sending", "generating"] as const) {
      const f = fixture(phase)
      expect((await handoffGptPro(f.client, "consultation")).phase).toBe("paused")
      expect(f.calls.map((call) => call.action)).toEqual(["status", "pause"])
    }
  })
  test("already paused conversations only reopen their browser", async () => {
    const f = fixture("paused")
    await handoffGptPro(f.client, "consultation")
    expect(f.calls.map((call) => call.action)).toEqual(["status", "open"])
  })
  test("a completion racing with pause reopens the finished page without a new consult", async () => {
    const f = fixture("generating", true)
    expect((await handoffGptPro(f.client, "consultation")).phase).toBe("completed")
    expect(f.calls.map((call) => call.action)).toEqual(["status", "pause", "status", "open"])
  })
})
