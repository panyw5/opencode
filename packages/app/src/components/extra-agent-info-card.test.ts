import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { ExtraAgentInfo } from "@/context/platform"
import { dict } from "../i18n/en"

let server: Awaited<ReturnType<typeof createServer>>
let render: (info?: ExtraAgentInfo, loading?: boolean, error?: string) => string
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    plugins: [solid({ solid: { generate: "ssr" } })],
    resolve: { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } },
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  })
  const { ExtraAgentInfoCard } = await server.ssrLoadModule(
    fileURLToPath(new URL("./extra-agent-info-card.tsx", import.meta.url)),
  )
  const { renderToString } = await server.ssrLoadModule("solid-js/web")
  render = (info, loading, error) =>
    renderToString(() => ExtraAgentInfoCard({ info, loading, error, t: (key: keyof typeof dict) => dict[key] }))
})
afterAll(async () => {
  await server?.close()
})

describe("persistent external-agent version cards", () => {
  test("renders both card slots immediately while data is pending", () => {
    const html = render(undefined, true)
    expect(html.match(/data-runtime-card=/g)).toHaveLength(2)
    expect(html).toContain('data-runtime-card="local-version"')
    expect(html).toContain('data-runtime-card="latest-version"')
    expect(html).toContain(dict["common.loading"])
    expect(html).toContain('aria-busy="true"')
  })
  test("retains cached values while refreshing and reserves the loading indicator slot", () => {
    const info: ExtraAgentInfo = { id: "hermes", sourceUrl: "test", localVersion: "1.0", latestVersion: "2.0" }
    const pending = render(info, true)
    const loaded = render(info, false)
    for (const html of [pending, loaded]) {
      expect(html.match(/data-runtime-card=/g)).toHaveLength(2)
      expect(html).toContain("1.0")
      expect(html).toContain("2.0")
      expect(html).toContain(dict["config.claws.info.loading"])
    }
    expect(loaded).toContain("invisible")
  })
  test("failed requests keep the cards mounted and report the error in place", () => {
    const html = render(undefined, false, "Status unavailable")
    expect(html.match(/data-runtime-card=/g)).toHaveLength(2)
    expect(html).toContain(dict["config.claws.info.unknown"])
    expect(html).toContain('role="alert"')
    expect(html).toContain("Status unavailable")
    expect(html).toContain('aria-busy="false"')
  })
  test("cached unknown versions do not flip back to a loading label during refresh", () => {
    const html = render({ id: "hermes", sourceUrl: "test", latestVersion: "2.0" }, true)
    expect(html).toContain(dict["config.claws.info.unknown"])
    expect(html).not.toContain(">" + dict["common.loading"] + "<")
    expect(html).toContain("2.0")
  })
})
