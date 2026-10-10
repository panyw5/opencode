import { describe, expect, test } from "bun:test"
import type { GptProCommand, GptProJob } from "@opencode-ai/util/gpt-pro"
import { parseGptProOutputFallback, resolveGptProView } from "./gpt-pro-result"
import { closeDialogIfCurrent } from "./gpt-pro-result-preview"

const job = (id: string, phase: GptProJob["phase"], extra: Partial<GptProJob> = {}): GptProJob => ({
  id,
  owner: "/repo\nsession",
  requestID: id,
  phase,
  prompt: "Original question",
  url: `https://chatgpt.com/c/${id}`,
  createdAt: 1,
  updatedAt: 1,
  submitted: phase === "completed",
  revision: 1,
  ...extra,
})

function client(run: (input: GptProCommand) => Promise<GptProJob>) {
  const calls: GptProCommand[] = []
  return {
    calls,
    api: {
      command: async (input: GptProCommand) => {
        calls.push(input)
        return run(input)
      },
    },
  }
}

describe("GPT-Pro cached result view", () => {
  test("uses full read output first and never opens the browser", async () => {
    const full = "Answer ".repeat(5000)
    const f = client(async (input) => {
      if (input.action === "read") return job("gpt_current", "completed", { text: full, html: "<script>unsafe</script>" })
      throw new Error(`Unexpected action ${input.action}`)
    })
    const result = await resolveGptProView(f.api, "gpt_original")
    expect(result.kind).toBe("cached")
    if (result.kind !== "cached") return
    expect(result.result.id).toBe("gpt_current")
    expect(result.result.text).toBe(full)
    expect(result.result.source).toBe("read")
    expect(f.calls.map((call) => call.action)).toEqual(["read"])
    expect(f.calls.some((call) => call.action === "open" || call.action === "send")).toBe(false)
  })

  test("uses only a final output fallback whose consultation ID matches the resolved job", async () => {
    const output = JSON.stringify({
      consultation_id: "gpt_current",
      phase: "completed",
      url: "https://chatgpt.com/c/gpt_current",
      text: "Saved fallback answer",
      html: "<img src=x onerror=alert(1)>",
    })
    const f = client(async (input) => {
      if (input.action === "status") return job("gpt_current", "completed")
      throw new Error("history pruned before full read")
    })
    const result = await resolveGptProView(f.api, "gpt_parent", output)
    expect(result.kind).toBe("cached")
    if (result.kind !== "cached") return
    expect(result.result.text).toBe("Saved fallback answer")
    expect(result.result.source).toBe("output")
    expect(parseGptProOutputFallback(output, "gpt_parent")).toBeUndefined()
    expect(f.calls.map((call) => call.action)).toEqual(["read", "status"])
  })

  test("does not reuse parent output after status redirects to a successor", async () => {
    const parentOutput = JSON.stringify({
      consultation_id: "gpt_parent",
      phase: "completed",
      url: "https://chatgpt.com/c/gpt_parent",
      text: "Stale parent answer",
    })
    const f = client(async (input) => {
      if (input.action === "status") return job("gpt_successor", "completed")
      throw new Error("successor history was pruned")
    })
    const result = await resolveGptProView(f.api, "gpt_parent", parentOutput)
    expect(result).toMatchObject({ kind: "unavailable", id: "gpt_successor" })
    expect(f.calls.map((call) => call.action)).toEqual(["read", "status"])
  })
  test("does not reuse a completed output when the current job is active after read failure", async () => {
    const output = JSON.stringify({ consultation_id: "gpt_active", phase: "completed", text: "Older result" })
    const f = client(async (input) => {
      if (input.action === "read") throw new Error("read unavailable")
      if (input.action === "status") return job("gpt_active", "generating")
      throw new Error(`Unexpected action ${input.action}`)
    })
    const result = await resolveGptProView(f.api, "gpt_active", output)
    expect(result.kind).toBe("live")
    expect(f.calls.map((call) => call.action)).toEqual(["read", "status"])
  })

  test("keeps active and recovery jobs on the live-page handoff path", async () => {
    const f = client(async (input) => {
      if (input.action === "read") return job("gpt_active", "paused", { recovery: { stage: "compose", reason: "repair" } })
      throw new Error(`Unexpected action ${input.action}`)
    })
    const result = await resolveGptProView(f.api, "gpt_active")
    expect(result.kind).toBe("live")
    expect(f.calls.map((call) => call.action)).toEqual(["read"])
  })

  test("does not accept non-final fallback output", () => {
    expect(
      parseGptProOutputFallback(
        JSON.stringify({ consultation_id: "gpt_active", phase: "generating", text: "partial" }),
        "gpt_active",
      ),
    ).toBeUndefined()
  })
  test("does not close a replacement dialog after a delayed open action", () => {
    let active = { id: "cached-result" }
    let closes = 0
    const dialog = {
      get active() {
        return active
      },
      close() {
        closes++
      },
    }
    const openedDialogID = dialog.active.id
    active = { id: "unrelated-dialog" }
    expect(closeDialogIfCurrent(dialog, openedDialogID)).toBe(false)
    expect(closes).toBe(0)
    expect(closeDialogIfCurrent(dialog, active.id)).toBe(true)
    expect(closes).toBe(1)
  })
})
