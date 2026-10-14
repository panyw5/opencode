import { describe, expect, test } from "bun:test"
import { DEFAULT_GPT_PRO_CONFIG, type GptProJob } from "@opencode-ai/util/gpt-pro"
import { createGptProPersistence } from "./gpt-pro-persistence"
import { GptProController } from "./gpt-pro-controller"

function fixture(initial: Record<string, unknown>) {
  let raw = JSON.stringify(initial)
  const reads: string[] = []
  const writes: string[] = []
  const logs: string[] = []
  let fail = false
  const store = {
    get(key: string) {
      reads.push(key)
      return JSON.parse(raw)[key]
    },
    set(key: string, value: unknown) {
      if (fail) throw new Error("write failed")
      writes.push(key)
      raw = JSON.stringify({ ...JSON.parse(raw), [key]: value })
    },
  }
  return {
    persistence: createGptProPersistence(store, (s) => logs.push(s)),
    reads,
    writes,
    logs,
    fail: () => (fail = true),
  }
}

describe("GPT Pro config persistence", () => {
  test("configuration reads never reparse history after initialization", () => {
    const f = fixture({
      config: { ...DEFAULT_GPT_PRO_CONFIG, enabled: false },
      jobs: [{ text: "x".repeat(2_000_000) }],
    })
    for (let i = 0; i < 120; i++) expect(f.persistence.config().enabled).toBe(false)
    expect(f.reads).toEqual(["config"])
    expect(f.writes).toEqual([])
    expect(f.logs[0]).toContain("config cache initialized enabled=false")
  })

  test("settings writes update the cache immediately without retaining mutable references", () => {
    const f = fixture({})
    expect(f.persistence.config()).toEqual(DEFAULT_GPT_PRO_CONFIG)
    const next = { ...DEFAULT_GPT_PRO_CONFIG, enabled: true }
    f.persistence.setConfig(next)
    next.enabled = false
    const returned = f.persistence.config()
    returned.enabled = false
    expect(f.persistence.config().enabled).toBe(true)
    expect(f.writes).toEqual(["config"])
    expect(f.reads).toEqual(["config"])
  })

  test("failed settings writes leave the previously persisted config effective", () => {
    const f = fixture({ config: { ...DEFAULT_GPT_PRO_CONFIG, enabled: false } })
    f.fail()
    expect(() => f.persistence.setConfig({ ...DEFAULT_GPT_PRO_CONFIG, enabled: true })).toThrow("write failed")
    expect(f.persistence.config().enabled).toBe(false)
  })

  test("large completed history survives load, save, and repeated notification polling without disk reads", () => {
    const jobs: GptProJob[] = Array.from({ length: 12 }, (_, i) => ({
      id: `gpt_history_${i}`,
      owner: "/tmp/test\nsession-test",
      requestID: `request-${i}`,
      phase: "completed",
      prompt: "history prompt",
      url: "https://chatgpt.com/c/test",
      createdAt: 1,
      updatedAt: 1,
      submitted: true,
      revision: 1,
      background: true,
      text: "x".repeat(100_000),
      html: "y".repeat(100_000),
      notificationPhase: "completed",
    }))
    const f = fixture({ config: { ...DEFAULT_GPT_PRO_CONFIG, enabled: false }, jobs })
    const controller = new GptProController(
      () => {
        throw new Error("completed history must not open a driver")
      },
      f.persistence,
      () => {},
    )
    try {
      const reads = f.reads.length
      const writes = f.writes.length
      for (let i = 0; i < 30; i++) expect(controller.notifications()).toEqual([])
      expect(f.reads.length).toBe(reads)
      expect(f.writes.length).toBe(writes)
      expect(controller.list()).toHaveLength(12)
      expect(f.persistence.load()[0].text).toHaveLength(100_000)
      controller.setConfig({ ...DEFAULT_GPT_PRO_CONFIG, enabled: false, progressIntervalSeconds: 120 })
      expect(controller.config().progressIntervalSeconds).toBe(120)
    } finally {
      controller.dispose()
    }
  })
})
