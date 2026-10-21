import { describe, expect, test } from "bun:test"
import { handoffGptPro } from "./gpt-pro-handoff"
import type { GptProCommand, GptProJob, GptProPhase } from "@opencode-ai/util/gpt-pro"
import { gptProExecutionSnapshot } from "@opencode-ai/util/gpt-pro-state"

function fixture(phase: GptProPhase, race = false) {
  const calls: GptProCommand[] = []
  let current = phase
  const client = {
    state: {
      read: async (requestedID: string) => ({
        sourceID: "test",
        sequence: 1,
        requestedID,
        state: {
          kind: "execution" as const,
          job: gptProExecutionSnapshot({
            id: "consultation",
            owner: "owner",
            requestID: "request",
            prompt: "prompt",
            phase: current,
            url: "https://chatgpt.com/",
            createdAt: 1,
            updatedAt: 1,
            revision: 0,
            submitted: true,
          }),
        },
      }),
      list: async () => ({ type: "snapshot" as const, sourceID: "test", sequence: 1, jobs: [], removed: [] }),
      subscribe: () => () => {},
    },
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
  test("viewing active conversations does not pause tracking or resend", async () => {
    for (const phase of ["preparing", "sending", "generating"] as const) {
      const f = fixture(phase)
      expect((await handoffGptPro(f.client, "consultation")).phase).toBe(phase)
      expect(f.calls.map((call) => call.action)).toEqual(["status", "open"])
    }
  })
  test("already paused conversations only reopen their browser", async () => {
    const f = fixture("paused")
    await handoffGptPro(f.client, "consultation")
    expect(f.calls.map((call) => call.action)).toEqual(["status", "open"])
  })
  test("viewing does not perform a handoff even if pause would race with completion", async () => {
    const f = fixture("generating", true)
    expect((await handoffGptPro(f.client, "consultation")).phase).toBe("generating")
    expect(f.calls.map((call) => call.action)).toEqual(["status", "open"])
  })
})
