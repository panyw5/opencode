import { describe, expect, test } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import solidPackage from "solid-js/package.json"
import { SHARED_EXPORTS } from "../../../extension-kit/shims.js"
import { HOST_SOLID_VERSION, installExtensionHostModules } from "./modules"
import { compareSolidVersions, ExtensionActivationManager, type WebExtensionModule } from "./activation"
import type { ExtensionInfo } from "./types"

// The host global is installed once for the whole file: it is intentionally
// non-configurable, so version-guard tests read the real frozen surface.
const host = installExtensionHostModules("test-opencode")

const manifest = (): ExtensionInfo => ({
  id: "test.viewer",
  version: "1.0.0",
  displayName: "Viewer",
  enabled: true,
  state: "ready",
  activation: [],
  contributes: {},
  web: {
    base: "http://127.0.0.1:4096/asset/",
    entry: "index.js",
    styles: [],
    apiVersion: 1,
  },
})

function manager(input: { load?: () => Promise<WebExtensionModule> } = {}) {
  const owner = createRoot((dispose) => {
    const current = getOwner()
    if (!current) throw new Error("owner required")
    return { current, dispose }
  })
  const instance = new ExtensionActivationManager({
    hostOwner: owner.current,
    importModule: input.load ?? (async () => ({ default: { id: "test.viewer", apiVersion: 1, activate() {} } })),
    addStyle: async () => () => {},
    registerViewer: () => () => {},
    registerToolRenderer: () => () => {},
    registerPanel: () => () => {},
    registerCommand: () => () => {},
    callRpc: () => Promise.resolve(undefined),
    listenEvents: () => () => {},
    readSetting: () => undefined,
    updateSettings: () => Promise.resolve(undefined),
  })
  return { instance, dispose: owner.dispose }
}

function captureWarnings() {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "))
  return { warnings, restore: () => (console.warn = original) }
}

describe("installExtensionHostModules", () => {
  test("reads the shared solid-js version from the installed package", () => {
    expect(HOST_SOLID_VERSION).toBe(solidPackage.version)
    expect(host.versions["solid-js"]).toBe(solidPackage.version)
    expect(host.versions["solid-js"]).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("freezes the host and installs it as non-writable, non-configurable", () => {
    expect(Object.isFrozen(host)).toBe(true)
    expect(Object.isFrozen(host.versions)).toBe(true)
    expect(Object.isFrozen(host.modules)).toBe(true)
    // Module namespace objects report writable live bindings in some runtimes
    // (Object.isFrozen returns false) but are still non-extensible and reject
    // writes; plain frozen objects satisfy both assertions as well.
    for (const mod of Object.values(host.modules)) {
      expect(Object.isExtensible(mod)).toBe(false)
    }
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__OPENCODE_EXTENSION_HOST__")
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.configurable).toBe(false)
    expect(descriptor?.value).toBe(host)
  })

  test("rejects module map and module member mutation in strict mode", () => {
    expect(() => {
      ;(host.modules as Record<string, unknown>)["evil"] = {}
    }).toThrow(TypeError)
    expect(host.modules["evil"]).toBeUndefined()
    expect(() => {
      ;(host.modules["solid-js"] as Record<string, unknown>)["createSignal"] = () => null
    }).toThrow(TypeError)
    expect(typeof host.modules["solid-js"]["createSignal"]).toBe("function")
  })

  test("reinstall returns the already installed frozen host", () => {
    expect(installExtensionHostModules("other")).toBe(host)
  })
})

// Parity with the extension-kit shim whitelist: the modules the host
// publishes and the modules kit rewrites imports to must stay in lockstep,
// and every name a shim re-exports must exist on the host module or the
// shim's load-time check rejects the extension. The per-module check runs
// in a --conditions=browser child because this test file resolves solid-js
// server builds, whose export surface omits DOM-only helpers the real
// (browser-bundled) host does provide.
describe("shared module whitelist parity", () => {
  test("host module ids match extension-kit SHARED_EXPORTS", () => {
    expect(Object.keys(host.modules).toSorted()).toEqual(Object.keys(SHARED_EXPORTS).toSorted())
  })

  test("browser host modules provide every export the kit shims re-export", async () => {
    const source = `
      import { installExtensionHostModules } from ${JSON.stringify(new URL("./modules.ts", import.meta.url).href)}
      const host = installExtensionHostModules()
      const keys = Object.fromEntries(Object.entries(host.modules).map(([id, mod]) => [id, Object.keys(mod)]))
      console.log(JSON.stringify(keys))
    `
    const child = Bun.spawn([process.execPath, "--conditions=browser", "-e", source], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code !== 0) throw new Error(`Browser host module inspection failed (${code}): ${stderr}`)
      const keys = JSON.parse(stdout) as Record<string, string[]>
      expect(Object.keys(keys).toSorted()).toEqual(Object.keys(SHARED_EXPORTS).toSorted())
      const missing = Object.entries(SHARED_EXPORTS).flatMap(([id, names]) =>
        names.filter((name) => !(keys[id] ?? []).includes(name)).map((name) => `${id}.${name}`),
      )
      expect(missing).toEqual([])
    } finally {
      clearTimeout(timer)
    }
  }, 15_000)
})

describe("compareSolidVersions", () => {
  test("classifies drift by semver component", () => {
    expect(compareSolidVersions("1.9.10", "1.9.0")).toBe("match")
    expect(compareSolidVersions("1.9.10", "1.10.0")).toBe("minor")
    expect(compareSolidVersions("1.9.10", "1.8.5")).toBe("minor")
    expect(compareSolidVersions("1.9.10", "2.0.0")).toBe("major")
    expect(compareSolidVersions("1.9.10", "0.9.0")).toBe("major")
    expect(compareSolidVersions("1.9.10", "not-a-version")).toBe("unknown")
    expect(compareSolidVersions("1.9.10", "2")).toBe("unknown")
  })
})

describe("solid-js version guard", () => {
  const [major, minor] = HOST_SOLID_VERSION.split(".").map((part) => Number(part))
  const minorDrift = `${major}.${minor + 1}.0`
  const majorDrift = `${major + 1}.0.0`

  test("warns but activates when the built minor differs", async () => {
    let activated = 0
    const { warnings, restore } = captureWarnings()
    try {
      const { instance, dispose } = manager({
        load: async () => ({
          __opencodeBuild: { solid: minorDrift },
          default: {
            id: "test.viewer",
            apiVersion: 1,
            activate() {
              activated++
            },
          },
        }),
      })
      await instance.activate(manifest())
      expect(activated).toBe(1)
      expect(warnings.some((entry) => entry.includes("solid-js minor mismatch"))).toBe(true)
      expect(warnings.some((entry) => entry.includes("test.viewer"))).toBe(true)
      await instance.deactivate("test.viewer")
      dispose()
    } finally {
      restore()
    }
  })

  test("rejects activation when the built major differs", async () => {
    let activated = 0
    const { instance, dispose } = manager({
      load: async () => ({
        __opencodeBuild: { solid: majorDrift },
        default: {
          id: "test.viewer",
          apiVersion: 1,
          activate() {
            activated++
          },
        },
      }),
    })
    await expect(instance.activate(manifest())).rejects.toThrow("incompatible solid-js")
    expect(activated).toBe(0)
    expect(instance.get("test.viewer")).toBeUndefined()
    dispose()
  })

  test("skips the check when build metadata is missing or malformed", async () => {
    const { warnings, restore } = captureWarnings()
    try {
      for (const build of [undefined, {}, { solid: 42 }, "x.y.z"]) {
        const { instance, dispose } = manager({
          load: async () => ({
            __opencodeBuild: build,
            default: { id: "test.viewer", apiVersion: 1, activate() {} },
          }),
        })
        await instance.activate(manifest())
        expect(instance.active("test.viewer")).toBe(true)
        await instance.deactivate("test.viewer")
        dispose()
      }
      expect(warnings.filter((entry) => entry.includes("solid-js"))).toEqual([])
    } finally {
      restore()
    }
  })
})
