import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { DEFAULT_GPT_PRO_CONFIG, type GptProRuntimeStatus } from "@opencode-ai/util/gpt-pro"
import { dict } from "../i18n/en"

test("runtime cards keep verified, pending and attention states distinct", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [solid({ solid: { generate: "ssr" } })],
    resolve: { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } },
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  })
  try {
    const { GptProRuntimeCards } = await server.ssrLoadModule(
      fileURLToPath(new URL("./gpt-pro-runtime-cards.tsx", import.meta.url)),
    )
    const { renderToString } = await server.ssrLoadModule("solid-js/web")
    const t = (key: keyof typeof dict) => dict[key]
    const runtime: GptProRuntimeStatus = {
      config: DEFAULT_GPT_PRO_CONFIG,
      login: { phase: "idle" },
      session: { profileID: "synthetic", generation: 1, revision: 1,
        authentication: { phase: "authenticated", account: "test@example.invalid", checkedAt: 1 },
        page: { phase: "interactive", model: "Pro" }, import: { phase: "verified" } },
      credentials: { phase: "available" },
      bridge: { connected: true },
      importBlocked: false,
      blockers: [],
    }
    const healthy = renderToString(() => GptProRuntimeCards({ runtime, t }))
    expect(healthy.match(/data-runtime-card=/g)).toHaveLength(4)
    expect(healthy).toContain('data-status="authentication"')
    expect(healthy).toContain("Signed in and verified")
    expect(healthy).toContain("test@example.invalid")
    expect(healthy).toContain("OS-encrypted")
    expect(healthy).toContain("Uses your selection in ChatGPT")
    expect(healthy).not.toContain("Connects this app to the consultation runtime")
    expect(healthy).not.toContain("Browser cookies stay in memory only")
    expect(healthy.match(/data-runtime-header/g)).toHaveLength(4)
    expect(healthy).not.toContain("text-20-medium")
    expect(healthy).not.toContain("text-14-medium")
    expect(healthy.match(/data-runtime-value/g)).toHaveLength(4)
    expect(healthy).toContain("font-weight:600")
    expect(healthy).toContain("text-right")
    expect(healthy).toContain("@[34rem]:grid-cols-2")
    const pending = renderToString(() => GptProRuntimeCards({ t }))
    expect(pending).toContain("Not verified yet")
    expect(pending).not.toContain('data-tone="healthy"')
    const blocked = renderToString(() =>
      GptProRuntimeCards({
        t,
        runtime: {
          ...runtime,
          session: { ...runtime.session, authentication: { phase: "verification", checkedAt: 1 } },
          credentials: { phase: "storage_fault" },
          bridge: { connected: false },
          importBlocked: true,
          blockers: [{ id: "gpt_test", phase: "generating" }],
        },
      }),
    )
    expect(blocked.match(/data-tone="attention"/g)).toHaveLength(3)
    expect(blocked).toContain("Browser verification required")
    expect(blocked).toContain("Secure storage unavailable")
    expect(blocked).toContain('data-status="import-blocked"')
    expect(blocked).toContain("gpt_test")
  } finally {
    await server.close()
  }
})
