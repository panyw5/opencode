import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { gptProTestMode, gptProTestSuites } from "./gpt-pro-test-suite"

test("default GPT-Pro selection is non-live and ambiguous flags cannot authorize a send", () => {
  expect(gptProTestMode([])).toBe("unit")
  for (const mode of [
    "unit",
    "list",
    "baseline",
    "native",
    "logged-out",
    "live",
    "live-rich",
    "live-multipage",
    "help",
  ] as const)
    expect(gptProTestMode([`--${mode}`])).toBe(mode)
  for (const args of [["--live", "--unit"], ["live"], ["--everything"], ["--live", "--force"]])
    expect(() => gptProTestMode(args)).toThrow()
})

test.each(["--prompt-part", "--prompt-file", "--clear-matching-draft", "--mask-model-ui", "--exercise-agent-recovery"])(
  "legacy %s cannot replay a user prompt or mutate an unrelated diagnostic page",
  (flag) => {
    const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./gpt-pro-e2e.ts", import.meta.url)), flag])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Legacy GPT-Pro E2E flags are retired")
  },
)

test("package-isolated discovery includes previously omitted GPT-Pro contracts and CDP helper tests", async () => {
  const suites = await gptProTestSuites(fileURLToPath(new URL("../../../", import.meta.url)))
  expect(suites.map((suite) => suite.name)).toEqual(["util", "desktop", "app", "ui", "opencode", "opencode-routing"])
  const find = (name: string) => suites.find((suite) => suite.name === name)!
  expect(find("desktop").files).toContain("scripts/gpt-pro-ui-cases.test.ts")
  expect(find("desktop").files).toContain("scripts/gpt-pro-test-suite.test.ts")
  expect(find("desktop").files).toContain("src/main/gpt-pro-session-coordinator.test.ts")
  expect(find("opencode").files).toContain("test/tool/gpt_pro_consult.test.ts")
  expect(find("opencode").files).toContain("test/session/gpt-pro-background.test.ts")
  expect(find("opencode").files).toContain("test/browser/gpt-pro-read-owners.test.ts")
  expect(find("app").files).toContain("src/components/prompt-input/gpt-pro-private-files.test.ts")
  expect(find("app").preload).toEqual(["--preload", "./happydom.ts"])
  expect(find("opencode-routing").files).toContain("test/session/prompt.test.ts")
  expect(find("opencode-routing").directory).toBe(find("opencode").directory)
  expect(find("opencode-routing").filter).toContain("@gpt-pro")
  for (const suite of suites) {
    expect(new Set(suite.files).size).toBe(suite.files.length)
    expect(suite.files.every((file) => file.endsWith(".test.ts"))).toBe(true)
    expect(suite.files.some((file) => file.includes("e2e"))).toBe(false)
  }
})
