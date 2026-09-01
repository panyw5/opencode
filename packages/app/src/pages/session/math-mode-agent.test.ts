import { describe, expect, test } from "bun:test"
import { mathModeIsAvailable, mathModeIsInitializing, mathModeLocksAgent } from "./math-mode-agent"

describe("mathModeIsAvailable", () => {
  test("is available for drafts and loaded root sessions", () => {
    expect(
      mathModeIsAvailable({ sessionID: undefined, sessionLoaded: false, parentSessionID: undefined, agentAvailable: true }),
    ).toBe(true)
    expect(
      mathModeIsAvailable({ sessionID: "parent", sessionLoaded: true, parentSessionID: undefined, agentAvailable: true }),
    ).toBe(true)
  })

  test("is unavailable for every subagent regardless of its title", () => {
    expect(
      mathModeIsAvailable({
        sessionID: "worker",
        sessionLoaded: true,
        parentSessionID: "parent",
        agentAvailable: true,
      }),
    ).toBe(false)
  })

  test("stays hidden while a session loads and when the agent is unavailable", () => {
    expect(
      mathModeIsAvailable({ sessionID: "worker", sessionLoaded: false, parentSessionID: undefined, agentAvailable: true }),
    ).toBe(false)
    expect(
      mathModeIsAvailable({ sessionID: "parent", sessionLoaded: true, parentSessionID: undefined, agentAvailable: false }),
    ).toBe(false)
  })
})

describe("mathModeIsInitializing", () => {
  test("stays pending for the submitted session until a worker is listed", () => {
    expect(mathModeIsInitializing({ sessionID: "parent", requestedSessionID: "parent", workerCount: 0 })).toBe(true)
    expect(mathModeIsInitializing({ sessionID: "parent", requestedSessionID: "parent", workerCount: 1 })).toBe(false)
  })

  test("does not leak the pending state to another session", () => {
    expect(mathModeIsInitializing({ sessionID: "other", requestedSessionID: "parent", workerCount: 0 })).toBe(false)
    expect(mathModeIsInitializing({ sessionID: undefined, requestedSessionID: "parent", workerCount: 0 })).toBe(false)
  })
})

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
