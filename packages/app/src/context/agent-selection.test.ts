import { describe, expect, test } from "bun:test"
import { internalAgent, selectableAgents } from "./agent-selection"

const agents = [
  { name: "build", mode: "primary", hidden: false },
  { name: "math-orchestrator", mode: "primary", hidden: true },
  { name: "math-worker", mode: "subagent", hidden: true },
]

describe("agent selection", () => {
  test("hides the math orchestrator from ordinary selection", () => {
    expect(selectableAgents(agents).map((agent) => agent.name)).toEqual(["build"])
  })

  test("still resolves the hidden math orchestrator for an internal lock", () => {
    expect(internalAgent(agents, "math-orchestrator")?.name).toBe("math-orchestrator")
    expect(internalAgent(agents, "math-worker")).toBeUndefined()
  })
})
