import { describe, expect, test } from "bun:test"
import {
  activeSelection,
  restoreMessageSelection,
  selectAgent,
  selectModel,
  selectVariant,
  type ModelSelection,
} from "./model-selection-state"

const session: ModelSelection = {
  agent: "build",
  model: { providerID: "provider", modelID: "session-model" },
  variant: "high",
}

describe("model selection state", () => {
  test("existing sessions never use draft or configured defaults", () => {
    expect(
      activeSelection({
        sessionID: "session",
        restored: session,
        draft: { model: { providerID: "provider", modelID: "configured-default" } },
      }),
    ).toEqual(session)
    expect(activeSelection({ sessionID: "session" })).toBeUndefined()
  })

  test("drafts use only draft and promotion state", () => {
    expect(activeSelection({ draft: session })).toEqual(session)
    expect(activeSelection({ promoting: session })).toEqual(session)
  })

  test("manual session selection wins over restored message state", () => {
    const manual = selectModel(session, { providerID: "provider", modelID: "manual-model" })
    expect(activeSelection({ sessionID: "session", manual, restored: session })).toEqual(manual)
  })

  test("selecting a model changes only the model and resets its variant", () => {
    expect(selectModel(session, { providerID: "other", modelID: "chosen" })).toEqual({
      agent: "build",
      model: { providerID: "other", modelID: "chosen" },
      variant: null,
    })
  })

  test("selecting the same agent is a no-op", () => {
    expect(selectAgent(session, { name: "build", model: { providerID: "other", modelID: "default" } })).toBe(session)
  })

  test("switching agents applies only the new agent default", () => {
    expect(
      selectAgent(session, {
        name: "review",
        model: { providerID: "other", modelID: "agent-default" },
        variant: "max",
      }),
    ).toEqual({
      agent: "review",
      model: { providerID: "other", modelID: "agent-default" },
      variant: "max",
    })
  })

  test("switching to an agent without a default preserves the model", () => {
    expect(selectAgent(session, { name: "review" })).toEqual({ ...session, agent: "review" })
  })

  test("variant selection does not change agent or model", () => {
    expect(selectVariant(session, null)).toEqual({ ...session, variant: null })
  })

  test("message restore never overwrites manual or promoted state", () => {
    expect(restoreMessageSelection({ manual: session, message: { agent: "build" } })).toBeUndefined()
    expect(restoreMessageSelection({ handoff: session, message: { agent: "build" } })).toBeUndefined()
    expect(restoreMessageSelection({ message: session })).toEqual(session)
  })
})
