import { beforeAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { SHARED_EXPORTS, sharedShim } from "../shims.js"

const runtimeModules = ["solid-js", "solid-js/web", "solid-js/store"] as const
const uiModules = ["@opencode-ai/ui/button", "@opencode-ai/ui/spinner"] as const

let runtimeExports: Record<string, string[]>
beforeAll(async () => {
  // Extensions consume the renderer's browser build, not Solid's server entry.
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      "-e",
      `const ids = ${JSON.stringify([...runtimeModules, ...uiModules])};
       const entries = await Promise.all(ids.map(async id => [id, Object.keys(await import(id)).toSorted()]));
       console.log(JSON.stringify(Object.fromEntries(entries)));`,
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`Browser runtime inspection failed (${code}): ${stderr}`)
    runtimeExports = JSON.parse(stdout)
  } finally {
    clearTimeout(timer)
  }
}, 15_000)

describe("extension host shims", () => {
  for (const id of runtimeModules) {
    test(`keeps ${id} exports aligned with the browser runtime`, () => {
      expect([...SHARED_EXPORTS[id]].toSorted()).toEqual(runtimeExports[id])
    })
  }

  for (const id of uiModules) {
    test(`keeps ${id} exports aligned with the browser runtime`, () => {
      expect([...SHARED_EXPORTS[id]].toSorted()).toEqual(runtimeExports[id])
    })
  }

  test("emits static named exports through the host module table", () => {
    const source = sharedShim("@opencode-ai/ui/button")
    expect(source).toContain('modules?.["@opencode-ai/ui/button"]')
    expect(source).toContain('export const Button = m["Button"]')
    expect(source).not.toContain("export *")
  })

  test("rejects unknown modules", () => {
    expect(() => sharedShim("solid-js/html")).toThrow("Unsupported OpenCode extension host module")
  })
})
