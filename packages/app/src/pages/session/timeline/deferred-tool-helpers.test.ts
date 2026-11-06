import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import {
  clearToolPartHydration,
  isToolPartHydrated,
  markToolPartHydrated,
  releaseToolPartHydration,
  shouldDeferToolPart,
  toolHydrationKey,
  observeToolPartViewport,
  hydrateCachedViewportTools,
} from "./deferred-tool-helpers"

const tool = (input: { id?: string; tool?: string; status?: ToolPart["state"]["status"] }): ToolPart =>
  ({
    id: input.id ?? "part_1",
    type: "tool",
    tool: input.tool ?? "bash",
    sessionID: "ses_1",
    messageID: "msg_1",
    callID: "call_1",
    state:
      input.status === "pending"
        ? { status: "pending", input: {} }
        : input.status === "running"
          ? {
              status: "running",
              input: {},
              time: { start: 1 },
            }
          : input.status === "error"
            ? { status: "error", input: {}, error: "failed", time: { start: 1, end: 2 } }
            : {
                status: "completed",
                input: {},
                output: "ok",
                metadata: {},
                time: { start: 1, end: 2 },
              },
  }) as ToolPart

describe("shouldDeferToolPart", () => {
  test("does not defer present_file cards", () => {
    expect(shouldDeferToolPart(tool({ tool: "present_file", status: "completed" }))).toBe(false)
    expect(shouldDeferToolPart(tool({ tool: "present_diagram", status: "completed" }))).toBe(false)
    expect(shouldDeferToolPart(tool({ tool: "present_task", status: "completed" }))).toBe(false)
  })
  test("defers collapsed completed tools", () => {
    expect(shouldDeferToolPart(tool({ status: "completed" }))).toBe(true)
  })

  test("never replaces saved GPT-Pro cards with a fixed-height skeleton", () => {
    for (const status of ["completed", "error", "pending", "running"] as const) {
      expect(shouldDeferToolPart(tool({ tool: "gpt_pro_consult", status }))).toBe(false)
    }
  })

  test("does not defer running or pending tools", () => {
    expect(shouldDeferToolPart(tool({ status: "running" }))).toBe(false)
    expect(shouldDeferToolPart(tool({ status: "pending" }))).toBe(false)
  })

  test("does not defer tools that open by default", () => {
    expect(shouldDeferToolPart(tool({ status: "completed" }), true)).toBe(false)
  })

  test("does not defer non-tool parts", () => {
    expect(shouldDeferToolPart({ id: "t1", type: "text", text: "hi" } as never)).toBe(false)
  })
})

describe("tool hydration cache", () => {
  test("hydrates only visible warm cards and batches viewport reads before layout writes", () => {
    const root = document.createElement("div")
    root.getBoundingClientRect = () => ({ top: 0, bottom: 800 }) as DOMRect
    let reads = 0
    const hydrated: number[] = []
    const stops: Array<() => void> = []
    for (const [index, top] of [0, 200, 900].entries()) {
      const card = document.createElement("div")
      card.dataset.slot = "deferred-tool-part"
      card.getBoundingClientRect = () => {
        reads++
        return { top, bottom: top + 100 } as DOMRect
      }
      root.append(card)
      stops.push(
        observeToolPartViewport(card, () => {
          expect(reads).toBe(3)
          hydrated.push(index)
        }),
      )
    }
    try {
      expect(hydrateCachedViewportTools(root)).toBe(2)
      expect(hydrated).toEqual([0, 1])
    } finally {
      for (const stop of stops) stop()
    }
  })
  test("tracks hydrated keys per session", () => {
    clearToolPartHydration()
    const key = toolHydrationKey("ses_a", "part_1")
    expect(isToolPartHydrated(key)).toBe(false)
    markToolPartHydrated(key, "viewport")
    expect(isToolPartHydrated(key)).toBe(true)
    clearToolPartHydration("ses_a")
    expect(isToolPartHydrated(key)).toBe(false)
  })

  test("releases viewport hydration on unmount but keeps user-opened forever", () => {
    clearToolPartHydration()
    const viewportKey = toolHydrationKey("ses_a", "part_viewport")
    const userKey = toolHydrationKey("ses_a", "part_user")
    const upgradedKey = toolHydrationKey("ses_a", "part_upgraded")

    markToolPartHydrated(viewportKey, "viewport")
    markToolPartHydrated(userKey, "user")
    // A viewport hydration later touched by the user upgrades to permanent.
    markToolPartHydrated(upgradedKey, "viewport")
    markToolPartHydrated(upgradedKey, "user")

    releaseToolPartHydration(viewportKey)
    releaseToolPartHydration(userKey)
    releaseToolPartHydration(upgradedKey)

    expect(isToolPartHydrated(viewportKey)).toBe(false)
    expect(isToolPartHydrated(userKey)).toBe(true)
    expect(isToolPartHydrated(upgradedKey)).toBe(true)
    clearToolPartHydration()
  })
})
