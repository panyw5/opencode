import { describe, expect, test } from "bun:test"
import {
  finishAdvisorIntervention,
  registerAdvisorIntervention,
  sendAdvisorIntervention,
  startAdvisorIntervention,
} from "../../src/tool/advisor-intervention"

const sessionID = "ses_advisor_intervention" as any

describe("advisor intervention", () => {
  test("holds an active advisor until the user sends a message or finishes", async () => {
    const handle = registerAdvisorIntervention({ sessionID, callID: "call-1", advisor: "codex" })
    expect(handle.snapshot()).toMatchObject({ available: true, active: false, advisor: "codex" })
    expect(startAdvisorIntervention({ sessionID, callID: "call-1" })).toBe(true)

    const waiting = handle.wait(new AbortController().signal)
    expect(handle.snapshot()).toMatchObject({ active: true, waitingForInput: true, busy: false })
    expect(sendAdvisorIntervention({ sessionID, callID: "call-1", message: "Please check the edge case." })).toBe(true)
    await expect(waiting).resolves.toEqual({ type: "message", message: "Please check the edge case." })

    const finishing = handle.wait(new AbortController().signal)
    expect(finishAdvisorIntervention({ sessionID, callID: "call-1" })).toBe(true)
    await expect(finishing).resolves.toEqual({ type: "finish" })
    handle.close()
  })

  test("queues a message while the advisor is producing a turn", async () => {
    const handle = registerAdvisorIntervention({ sessionID, callID: "call-2", advisor: "claude" })
    expect(startAdvisorIntervention({ sessionID, callID: "call-2" })).toBe(true)
    expect(sendAdvisorIntervention({ sessionID, callID: "call-2", message: "hello" })).toBe(true)
    expect(handle.snapshot()).toMatchObject({ active: true, queued: true, waitingForInput: false })
    await expect(handle.wait(new AbortController().signal)).resolves.toEqual({ type: "message", message: "hello" })
    expect(handle.snapshot()).toMatchObject({ queued: false, waitingForInput: false })
    handle.close()
  })

  test("startAdvisorIntervention is idempotent once active", () => {
    const handle = registerAdvisorIntervention({ sessionID, callID: "call-idem", advisor: "grok" })
    expect(startAdvisorIntervention({ sessionID, callID: "call-idem" })).toBe(true)
    expect(startAdvisorIntervention({ sessionID, callID: "call-idem" })).toBe(true)
    expect(handle.snapshot()).toMatchObject({ active: true })
    handle.close()
  })
})
