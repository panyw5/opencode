import { describe, expect, test } from "bun:test"
import type { CliAgentConfig, CliAgentDescriptor, CliAgentInfo, CliAgents } from "@/context/platform"
import {
  filterAgentsForConsultMentions,
  isConsultMentionID,
  loadReadyConsultMentions,
} from "./consult-mentions"

function descriptor(id: "codex" | "claude" | "grok" | "dsh", label?: string): CliAgentDescriptor {
  return {
    id,
    label: label ?? id,
    command: id,
    sourceUrl: "https://example.com",
    configHomeLabel: "HOME",
    configHomePlaceholder: "~",
  }
}

function mockCliAgents(input: {
  list?: CliAgentDescriptor[]
  get?: Partial<Record<string, CliAgentConfig>>
  info?: Partial<Record<string, CliAgentInfo>>
  failInfo?: string[]
}): CliAgents {
  const failInfo = new Set(input.failInfo ?? [])
  return {
    list: async () => input.list ?? [],
    get: async (id) => input.get?.[id] ?? { enabled: true },
    set: async () => {},
    test: async () => ({ ok: true, logs: [] }),
    info: async (id) => {
      if (failInfo.has(id)) throw new Error("probe failed")
      return (
        input.info?.[id] ?? {
          sourceUrl: "https://example.com",
          installed: false,
        }
      )
    },
  }
}

describe("consult-mentions", () => {
  test("isConsultMentionID matches reserved ids", () => {
    expect(isConsultMentionID("codex")).toBe(true)
    expect(isConsultMentionID("claude")).toBe(true)
    expect(isConsultMentionID("grok")).toBe(true)
    expect(isConsultMentionID("dsh")).toBe(true)
    expect(isConsultMentionID("explore")).toBe(false)
  })

  test("filterAgentsForConsultMentions hides reserved names", () => {
    const agents = [{ name: "explore" }, { name: "codex" }, { name: "dsh" }, { name: "planner" }]
    expect(filterAgentsForConsultMentions(agents).map((a) => a.name)).toEqual(["explore", "planner"])
  })

  test("loadReadyConsultMentions returns only enabled + installed", async () => {
    const api = mockCliAgents({
      list: [
        descriptor("codex", "Codex"),
        descriptor("claude", "Claude"),
        descriptor("grok", "Grok"),
        descriptor("dsh", "DeepSeek"),
      ],
      get: {
        codex: { enabled: true },
        claude: { enabled: false },
        grok: { enabled: true },
        dsh: { enabled: true },
      },
      info: {
        codex: { sourceUrl: "x", installed: true },
        claude: { sourceUrl: "x", installed: true },
        grok: { sourceUrl: "x", installed: false },
        dsh: { sourceUrl: "x", installed: true },
      },
    })
    const ready = await loadReadyConsultMentions(api)
    expect(ready).toEqual([
      { id: "codex", name: "codex", display: "Codex" },
      { id: "dsh", name: "dsh", display: "DeepSeek" },
    ])
  })

  test("loadReadyConsultMentions returns empty without api", async () => {
    expect(await loadReadyConsultMentions(undefined)).toEqual([])
  })

  test("loadReadyConsultMentions skips probe failures", async () => {
    const api = mockCliAgents({
      list: [descriptor("codex"), descriptor("claude")],
      info: {
        claude: { sourceUrl: "x", installed: true },
      },
      failInfo: ["codex"],
    })
    const ready = await loadReadyConsultMentions(api)
    expect(ready.map((r) => r.id)).toEqual(["claude"])
  })
})
