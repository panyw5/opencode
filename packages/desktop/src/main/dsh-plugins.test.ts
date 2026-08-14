import { describe, expect, test } from "bun:test"
import { parseDshDumpConfig, upsertPluginDisabledPatch } from "./dsh-status"

const SAMPLE = `# == @deepseek-ai/dsh-base
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-headless
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  config:
    root:
      - .
  disabled: true
# == @deepseek-ai/dsh-base
- id: llm
  name: '@deepseek-ai/dsh-llm'
- id: session-title
  name: '@deepseek-ai/dsh-session-title'
  config:
    fallbackMaxWords: 5
    fallbackMaxBytes: 40
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.platform === 'win32'
  config:
    timeoutMs: 60000
# == @deepseek-ai/dsh-headless
- id: headless-runner
  name: '@deepseek-ai/dsh-headless'
`

describe("parseDshDumpConfig", () => {
  test("parses plugin rows with sources and disabled flags", () => {
    const plugins = parseDshDumpConfig(SAMPLE)
    expect(plugins.map((plugin) => plugin.id)).toEqual([
      "timer",
      "hmr",
      "llm",
      "session-title",
      "bash-sandbox",
      "headless-runner",
    ])

    const hmr = plugins.find((plugin) => plugin.id === "hmr")
    expect(hmr?.name).toBe("@deepseek-ai/cordis-plugin-hmr")
    expect(hmr?.source).toBe("@deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-headless")
    expect(hmr?.disabled).toBe(true)
    expect(hmr?.configPreview).toContain("root:")

    const llm = plugins.find((plugin) => plugin.id === "llm")
    expect(llm?.disabled).toBeUndefined()
    expect(llm?.configPreview).toBeUndefined()

    const bash = plugins.find((plugin) => plugin.id === "bash-sandbox")
    expect(bash?.disabled).toBe("!!js process.platform === 'win32'")
    expect(bash?.configPreview).toContain("timeoutMs: 60000")

    const runner = plugins.find((plugin) => plugin.id === "headless-runner")
    expect(runner?.source).toBe("@deepseek-ai/dsh-headless")
  })

  test("returns empty list for empty dump", () => {
    expect(parseDshDumpConfig("")).toEqual([])
    expect(parseDshDumpConfig("# == only a section\n")).toEqual([])
  })
})

describe("upsertPluginDisabledPatch", () => {
  test("disables a plugin by appending a patch entry", () => {
    const next = upsertPluginDisabledPatch("[]\n", "hmr", true)
    expect(next).toContain("- id: hmr")
    expect(next).toContain("disabled: true")
  })

  test("enabling removes a disabled-only entry", () => {
    const disabled = upsertPluginDisabledPatch("[]\n", "hmr", true)
    const enabled = upsertPluginDisabledPatch(disabled, "hmr", false)
    expect(enabled).toContain("[]")
    expect(enabled).not.toContain("disabled: true")
  })

  test("preserves other fields when re-enabling", () => {
    const base = ["- id: tools", "  config:", "    mode: strict", "  disabled: true", ""].join("\n")
    const next = upsertPluginDisabledPatch(base, "tools", false)
    expect(next).toContain("- id: tools")
    expect(next).toContain("mode: strict")
    expect(next).not.toContain("disabled: true")
  })
})
