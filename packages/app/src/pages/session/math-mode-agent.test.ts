import { describe, expect, test } from "bun:test"
import { mathModeLocksAgent } from "./math-mode-agent"

describe("mathModeLocksAgent", () => {
  test("locks an orchestrator session and a parent with durable workers", () => {
    expect(
      mathModeLocksAgent({ prepared: false, sessionAgent: "math-orchestrator", childAgents: [], subagent: false }),
    ).toBe(true)
    expect(
      mathModeLocksAgent({ prepared: false, sessionAgent: "build", childAgents: ["math-worker"], subagent: false }),
    ).toBe(true)
  })

  test("locks immediately after configuration is prepared", () => {
    expect(mathModeLocksAgent({ prepared: true, sessionAgent: "build", childAgents: [], subagent: false })).toBe(true)
  })

  test("does not lock ordinary or child sessions", () => {
    expect(mathModeLocksAgent({ prepared: false, sessionAgent: "build", childAgents: [], subagent: false })).toBe(false)
    expect(
      mathModeLocksAgent({
        prepared: true,
        sessionAgent: "math-worker",
        childAgents: ["math-worker"],
        subagent: true,
      }),
    ).toBe(false)
  })
})
