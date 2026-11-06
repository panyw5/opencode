import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { AgentStatusCard } from "./agent-status-card"

type CardProps = Parameters<typeof AgentStatusCard>[0]
let server: Awaited<ReturnType<typeof createServer>>
let render: (props: CardProps) => string
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    plugins: [solid({ solid: { generate: "ssr" } })],
    resolve: { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } },
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  })
  const module = await server.ssrLoadModule(fileURLToPath(new URL("./agent-status-card.tsx", import.meta.url)))
  const { renderToString } = await server.ssrLoadModule("solid-js/web")
  render = (props) =>
    renderToString(() =>
      module.AgentStatusGrid({
        get children() {
          return module.AgentStatusCard(props)
        },
      }),
    )
})
afterAll(async () => {
  await server?.close()
})

const base: CardProps = {
  kind: "installation",
  title: "Install status",
  icon: "circle-check",
  tone: "neutral",
  value: "Unknown",
}

describe("shared external-agent status cards", () => {
  test("uses a single border without an additional outline shadow in every state", () => {
    for (const tone of ["neutral", "healthy", "attention"] as const) {
      const html = render({ ...base, tone })
      const classes = html.match(/<article\b[^>]*\bclass="([^"]*)"/)?.[1].split(/\s+/)
      expect(classes).toBeDefined()
      expect(classes).toContain("border")
      expect(classes?.filter((name) => /^(?:shadow|ring|outline)(?:-|$)/.test(name))).toEqual([])
    }
  })

  test("uses the GPT-Pro icon, value, status indicator and container-responsive grid", () => {
    const html = render(base)
    expect(html).toContain('data-runtime-card="installation"')
    expect(html).toContain("data-runtime-header")
    expect(html).toContain("data-runtime-value")
    expect(html).toContain("font-weight:600")
    expect(html).toContain("@[34rem]:grid-cols-2")
    expect(html).toContain("@[64rem]:grid-cols-4")
    expect(html).toContain('aria-live="polite"')
  })

  test("neutral, success and attention states retain independent status colors", () => {
    const neutral = render(base)
    expect(neutral).toContain('data-tone="neutral"')
    expect(neutral).toContain("bg-icon-weak")
    expect(neutral).not.toContain("bg-text-success-base")
    const healthy = render({ ...base, tone: "healthy", value: "Installed" })
    expect(healthy).toContain('data-tone="healthy"')
    expect(healthy).toContain("bg-text-success-base")
    expect(healthy).toContain("bg-surface-success-weak/40")
    expect(healthy).toContain("border-border-weak-base")
    expect(healthy).not.toContain("border-border-success-base")
    expect(healthy).not.toContain("bg-gradient-to-br")
    const attention = render({ ...base, tone: "attention", value: "Not installed" })
    expect(attention).toContain('data-tone="attention"')
    expect(attention).toContain("bg-text-warning-base")
  })

  test("long paths can wrap and retain their copy action", () => {
    const path = "/workspace/" + "very-long-directory/".repeat(12) + "config.json"
    const html = render({ ...base, kind: "config-path", value: path, monospace: true, action: "Copy path" })
    expect(html).toContain(path)
    expect(html).toContain("min-w-0 max-w-full")
    expect(html).toContain("font-mono break-all select-text")
    expect(html).toContain("Copy path")
  })

  test("loading animates its icon without claiming a healthy result", () => {
    const html = render({ ...base, kind: "connection-test", icon: "refresh", loading: true, value: "Testing" })
    expect(html).toContain("animate-spin")
    expect(html).toContain('data-tone="neutral"')
    expect(html).not.toContain("bg-text-success-base")
  })
})
