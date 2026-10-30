import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { DEFAULT_GPT_PRO_CONFIG, type GptProRuntimeStatus } from "@opencode-ai/util/gpt-pro"
import { dict } from "../i18n/en"

let server: Awaited<ReturnType<typeof createServer>>
let render: (runtime?: GptProRuntimeStatus) => string
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    plugins: [solid({ solid: { generate: "ssr" } })],
    resolve: { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } },
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  })
  const { GptProRuntimeCards } = await server.ssrLoadModule(
    fileURLToPath(new URL("./gpt-pro-runtime-cards.tsx", import.meta.url)),
  )
  const { renderToString } = await server.ssrLoadModule("solid-js/web")
  render = (runtime) => renderToString(() => GptProRuntimeCards({ runtime, t: (key: keyof typeof dict) => dict[key] }))
})
afterAll(async () => {
  await server?.close()
})

const runtime = (): GptProRuntimeStatus => ({
  config: DEFAULT_GPT_PRO_CONFIG,
  login: { phase: "expired" },
  session: {
    profileID: "synthetic",
    generation: 1,
    revision: 1,
    authentication: { phase: "authenticated", account: "test@example.invalid", checkedAt: 1 },
    page: { phase: "interactive", model: "Pro" },
    import: { phase: "verified" },
  },
  credentials: { phase: "available" },
  bridge: { connected: true },
  importBlocked: false,
  blockers: [],
})
function card(html: string, kind: string) {
  const match = html.match(new RegExp('<article[^>]*data-runtime-card="' + kind + '"[\\s\\S]*?</article>'))
  expect(match).not.toBeNull()
  return match![0]
}

describe("canonical GPT-Pro runtime cards", () => {
  test("layout keeps four compact cards and verified identity separate from the user's model", () => {
    const html = render(runtime())
    expect(html.match(/data-runtime-card=/g)).toHaveLength(4)
    expect(html.match(/data-runtime-header/g)).toHaveLength(4)
    expect(html.match(/data-runtime-value/g)).toHaveLength(4)
    expect(html).toContain("font-weight:600")
    expect(html).toContain("text-right")
    expect(html).toContain("@[34rem]:grid-cols-2")
    expect(html).not.toContain("text-20-medium")
    expect(html).not.toContain("text-14-medium")
    expect(card(html, "identity")).toContain("test@example.invalid")
    expect(card(html, "model")).toContain("Uses your selection in ChatGPT")
    expect(card(html, "model")).toContain('data-tone="neutral"')
    expect(card(html, "storage")).toContain("OS-encrypted")
  })
  const phases = {
    unverified: ["neutral", "gptPro.auth.unknown"],
    verifying: ["neutral", "gptPro.auth.loading"],
    authenticated: ["healthy", "gptPro.auth.authenticated"],
    invalid: ["attention", "gptPro.auth.needsLogin"],
    verification: ["attention", "gptPro.auth.verification"],
    transient: ["neutral", "gptPro.auth.unknown"],
  } satisfies Record<GptProRuntimeStatus["session"]["authentication"]["phase"], [string, keyof typeof dict]>
  for (const [phase, [tone, label]] of Object.entries(phases)) {
    test("identity renders " + phase + " without inferring login from Cookies, Pro or bridge status", () => {
      const r = runtime()
      r.session.authentication = { phase: phase as typeof r.session.authentication.phase, checkedAt: 1 }
      const identity = card(render(r), "identity")
      expect(identity).toContain('data-tone="' + tone + '"')
      expect(identity).toContain(dict[label])
      if (phase !== "authenticated") expect(identity).not.toContain("Signed in and verified")
    })
  }
  test("unavailable runtime never claims verified login or healthy storage", () => {
    const html = render()
    expect(html).toContain("Not verified yet")
    expect(html).not.toContain('data-tone="healthy"')
  })
  test("credential storage fault and verified website identity remain orthogonal", () => {
    const r = runtime()
    r.credentials = { phase: "storage_fault" }
    const html = render(r)
    expect(card(html, "identity")).toContain("Signed in and verified")
    expect(card(html, "storage")).toContain("Secure storage unavailable")
    expect(card(html, "storage")).toContain('data-tone="attention"')
  })
  test("import blockers show execution ownership without changing authentication", () => {
    const r = runtime()
    r.importBlocked = true
    r.blockers = [{ id: "gpt_test", phase: "generating" }]
    const html = render(r)
    expect(html).toContain('data-status="import-blocked"')
    expect(html).toContain("gpt_test")
    expect(card(html, "identity")).toContain("Signed in and verified")
  })
})
