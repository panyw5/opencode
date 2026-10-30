import { expect, test } from "bun:test"
import { DEFAULT_GPT_PRO_CONFIG, GPT_PRO_PARTITION, type GptProSessionState } from "@opencode-ai/util/gpt-pro"
import { gptProRuntimeSnapshot } from "./gpt-pro-runtime-snapshot"

test("runtime snapshots expose orthogonal cached states and never duplicate job history", () => {
  const session: GptProSessionState = {
    profileID: GPT_PRO_PARTITION,
    generation: 2,
    revision: 3,
    authentication: { phase: "transient", checkedAt: 10, retryAt: 100 },
    page: { phase: "navigation_error" },
    import: { phase: "pending_verification" },
  }
  for (let i = 0; i < 100; i++) {
    const result = gptProRuntimeSnapshot({
      session,
      config: DEFAULT_GPT_PRO_CONFIG,
      login: { phase: "expired" },
      credentials: { phase: "available" },
      bridge: { connected: true },
      managed: { importBlocked: false, blockers: [] },
    })
    expect("authentication" in result).toBe(false)
    expect(result.session?.authentication.phase).toBe("transient")
    expect(result.session?.page.phase).toBe("navigation_error")
    expect("jobs" in result).toBe(false)
    expect(JSON.stringify(result).length).toBeLessThan(1000)
  }
})
