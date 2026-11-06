import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type {
  ExtraAgentId,
  ExtraAgentInfo,
  GenericagentConfig,
  HermesConfig,
  OpenclawConfig,
} from "../src/context/platform"
import { createExtraAgentInfoLoader } from "../src/pages/config-extra-agent-info"

type Config = OpenclawConfig | HermesConfig | GenericagentConfig
const flush = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}
const result = (id: ExtraAgentId, version: string): ExtraAgentInfo => ({
  id,
  sourceUrl: "test",
  localVersion: version,
  latestVersion: version,
})
function fixture() {
  const requests: {
    id: ExtraAgentId
    config?: Config
    resolve: (info: ExtraAgentInfo) => void
    reject: (error: Error) => void
  }[] = []
  return createRoot((dispose) => {
    const [state, set] = createStore<{
      selected: ExtraAgentId | undefined
      ready: boolean
      snapshot: { config?: Config }
      error: unknown
    }>({
      selected: "hermes",
      ready: false,
      snapshot: { config: { enabled: false } },
      error: undefined,
    })
    const info = createExtraAgentInfoLoader({
      selected: () => state.selected,
      ready: () => state.ready,
      config: () => state.snapshot.config,
      configError: () => state.error,
      inspect: (id, config) => {
        const snapshot = structuredClone(config)
        return new Promise((resolve, reject) => requests.push({ id, config: snapshot, resolve, reject }))
      },
    })
    return { info, set, requests, dispose, config: (config: Config) => set("snapshot", { config }) }
  })
}

describe("local external-agent status loading", () => {
  test("waits for configuration and retains cached versions throughout a local refresh", async () => {
    const ctx = fixture()
    try {
      expect(ctx.info.loading).toBe(true)
      expect(ctx.info.latest).toBeUndefined()
      expect(ctx.requests).toHaveLength(0)
      ctx.set("ready", true)
      await flush()
      ctx.requests[0].resolve(result("hermes", "1.0"))
      await flush()
      expect(ctx.info.loading).toBe(false)
      expect(ctx.info.latest?.localVersion).toBe("1.0")
      ctx.set("ready", false)
      expect(ctx.info.latest?.localVersion).toBe("1.0")
      expect(ctx.info.loading).toBe(true)
      ctx.config({ enabled: false, hermesDir: "/new-hermes" })
      ctx.set("ready", true)
      await flush()
      expect(ctx.requests).toHaveLength(2)
      expect(ctx.requests[1].id).toBe("hermes")
      expect(ctx.info.latest?.localVersion).toBe("1.0")
      ctx.requests[1].resolve(result("hermes", "2.0"))
      await flush()
      expect(ctx.info.latest?.localVersion).toBe("2.0")
      expect(ctx.info.loading).toBe(false)
    } finally {
      ctx.dispose()
    }
  })

  test("isolates agents and ignores results from a previously selected request", async () => {
    const ctx = fixture()
    try {
      ctx.set("ready", true)
      await flush()
      ctx.requests[0].resolve(result("hermes", "hermes-cached"))
      await flush()
      ctx.config({ enabled: false, hermesDir: "/refresh" })
      await flush()
      const stale = ctx.requests[1]
      ctx.set("selected", "genericagent")
      await flush()
      expect(ctx.info.latest).toBeUndefined()
      expect(ctx.requests[2].id).toBe("genericagent")
      stale.resolve(result("hermes", "stale"))
      ctx.requests[2].resolve(result("genericagent", "generic-current"))
      await flush()
      expect(ctx.info.latest?.id).toBe("genericagent")
      expect(ctx.info.latest?.localVersion).toBe("generic-current")
      ctx.set("selected", "hermes")
      expect(ctx.info.latest?.localVersion).toBe("hermes-cached")
      await flush()
      expect(ctx.requests[3].id).toBe("hermes")
    } finally {
      ctx.dispose()
    }
  })

  test("reports failures locally without discarding versions or retaining obsolete response fields", async () => {
    const ctx = fixture()
    try {
      ctx.set("ready", true)
      await flush()
      ctx.requests[0].resolve({ ...result("hermes", "1.0"), error: "Old upstream error" })
      await flush()
      ctx.config({ enabled: false, hermesDir: "/refresh" })
      await flush()
      ctx.requests[1].reject(new Error("Status unavailable"))
      await flush()
      expect(ctx.info.latest?.localVersion).toBe("1.0")
      expect(String(ctx.info.error)).toContain("Status unavailable")
      expect(ctx.info.loading).toBe(false)
      ctx.config({ enabled: false, hermesDir: "/retry" })
      await flush()
      ctx.requests[2].resolve(result("hermes", "2.0"))
      await flush()
      expect(ctx.info.error).toBeUndefined()
      expect(ctx.info.latest?.error).toBeUndefined()
      ctx.set("error", new Error("Configuration unavailable"))
      expect(ctx.info.loading).toBe(false)
      expect(ctx.info.latest?.localVersion).toBe("2.0")
      expect(String(ctx.info.error)).toContain("Configuration unavailable")
    } finally {
      ctx.dispose()
    }
  })

  test("does not publish a pending result after the page is disposed", async () => {
    const ctx = fixture()
    ctx.set("ready", true)
    await flush()
    ctx.dispose()
    ctx.requests[0].resolve(result("hermes", "late"))
    await flush()
    expect(ctx.info.latest).toBeUndefined()
  })
})
