import { beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HOST_GLOBAL, SHARED_EXPORTS, sharedShim } from "../shims.js"

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

// The generated shim is evaluated as a real ES module so the host-table
// lookups and export checks run exactly as they do in the app. A temp file
// is used instead of a data: URL because `?` in the source (optional
// chaining) breaks data: URL resolution.
const loadShim = async (source: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-shim-"))
  const file = path.join(dir, "shim.mjs")
  fs.writeFileSync(file, source)
  try {
    return await import(pathToFileURL(file).href)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
const hostGlobal = globalThis as Record<string, unknown>

describe("shim host table checks", () => {
  test("re-exports bindings from the host module", async () => {
    const Button = () => null
    hostGlobal[HOST_GLOBAL] = { modules: { "@opencode-ai/ui/button": { Button } } }
    try {
      const mod = await loadShim(sharedShim("@opencode-ai/ui/button"))
      expect(mod.Button).toBe(Button)
    } finally {
      delete hostGlobal[HOST_GLOBAL]
    }
  })

  test("throws when the host module table is missing", async () => {
    delete hostGlobal[HOST_GLOBAL]
    await expect(loadShim(sharedShim("@opencode-ai/ui/button"))).rejects.toThrow(
      "OpenCode host module is unavailable: @opencode-ai/ui/button",
    )
  })

  test("throws a clear error when the host is missing an export", async () => {
    hostGlobal[HOST_GLOBAL] = { modules: { "@opencode-ai/ui/button": { NotButton: () => null } } }
    try {
      await expect(loadShim(sharedShim("@opencode-ai/ui/button"))).rejects.toThrow(
        'OpenCode host module "@opencode-ai/ui/button" is missing exports: Button',
      )
    } finally {
      delete hostGlobal[HOST_GLOBAL]
    }
  })

  test("lists every missing export instead of failing on the first", async () => {
    hostGlobal[HOST_GLOBAL] = { modules: { "solid-js/store": {} } }
    try {
      await expect(loadShim(sharedShim("solid-js/store"))).rejects.toThrow(/missing exports: .+createStore.+produce/)
    } finally {
      delete hostGlobal[HOST_GLOBAL]
    }
  })
})
