import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { activateWithStyleRecovery, addExtensionStyle, ExtensionStyleLoadError } from "./activation"
import type { ExtensionInfo } from "./types"

const ID = "test.styles"
const URL = "http://127.0.0.1:4096/extension-asset/private-token/test.styles/old/index.css"
const manifest = (base = "old"): ExtensionInfo => ({
  id: ID,
  displayName: "Style fixture",
  version: "1",
  enabled: true,
  state: "ready",
  activation: [],
  contributes: {},
  web: { base: `http://127.0.0.1:4096/${base}/`, entry: "index.js", styles: [URL], apiVersion: 1 },
})

afterEach(() => mock.restore())

function links() {
  const added: HTMLLinkElement[] = []
  const removed: HTMLLinkElement[] = []
  const create = document.createElement.bind(document)
  spyOn(document, "createElement").mockImplementation(((name: string, options?: ElementCreationOptions) => {
    const element = create(name, options)
    if (name === "link")
      spyOn(element, "remove").mockImplementation(() => {
        removed.push(element as HTMLLinkElement)
      })
    return element
  }) as typeof document.createElement)
  // Drive load/error events explicitly without making network requests.
  spyOn(document.head, "append").mockImplementation((...elements) => {
    added.push(...(elements as HTMLLinkElement[]))
  })
  return { added, removed }
}

describe("extension stylesheet loading", () => {
  test("waits for CSS load and returns an idempotent cleanup", async () => {
    const state = links()
    let ready = false
    const loading = addExtensionStyle(URL, ID)
    void loading.then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)
    expect(state.added[0].rel).toBe("stylesheet")
    expect(state.added[0].dataset.extension).toBe(ID)
    state.added[0].dispatchEvent(new Event("load"))
    const remove = await loading
    expect(ready).toBe(true)
    expect(state.removed).toEqual([])
    remove()
    remove()
    expect(state.removed).toEqual(state.added)
  })

  test("CSS errors reject instead of activating an unstyled viewer", async () => {
    const state = links()
    const result = addExtensionStyle(URL, ID).catch((error) => error)
    state.added[0].dispatchEvent(new Event("error"))
    const error = await result
    expect(error).toBeInstanceOf(ExtensionStyleLoadError)
    expect(String(error)).toContain("failed to load")
    expect(String(error)).not.toContain("private-token")
    expect(state.removed).toEqual(state.added)
    state.added[0].dispatchEvent(new Event("load"))
    expect(state.removed).toHaveLength(1)
  })

  test("stalled CSS loads time out and remove their link", async () => {
    const state = links()
    const result = await addExtensionStyle(URL, ID, { timeoutMs: 5 }).catch((error) => error)
    expect(result).toBeInstanceOf(ExtensionStyleLoadError)
    expect(String(result)).toContain("timed out")
    expect(state.removed).toEqual(state.added)
  })
})

describe("stylesheet activation recovery", () => {
  test("refreshes the manifest and retries using the current asset version", async () => {
    let current = manifest()
    let refreshed = 0
    const attempts: string[] = []
    const active = await activateWithStyleRecovery({
      id: ID,
      current: () => current,
      available: () => true,
      refresh: async () => {
        refreshed++
        current = manifest("new")
      },
      activate: async (item) => {
        attempts.push(item.web!.base)
        if (attempts.length === 1) throw new ExtensionStyleLoadError(ID, "index.css", "failed to load")
      },
    })
    expect(active).toBe(true)
    expect(refreshed).toBe(1)
    expect(attempts).toEqual([manifest().web!.base, manifest("new").web!.base])
  })

  test("persistent CSS failure stops after one retry", async () => {
    let attempts = 0
    let refreshed = 0
    const result = await activateWithStyleRecovery({
      id: ID,
      current: () => manifest(),
      available: () => true,
      refresh: async () => {
        refreshed++
      },
      activate: async () => {
        attempts++
        throw new ExtensionStyleLoadError(ID, "index.css", "failed to load")
      },
    }).catch((error) => error)
    expect(result).toBeInstanceOf(ExtensionStyleLoadError)
    expect(attempts).toBe(2)
    expect(refreshed).toBe(1)
  })

  test("module errors do not trigger a stylesheet retry", async () => {
    let refreshed = false
    const result = await activateWithStyleRecovery({
      id: ID,
      current: () => manifest(),
      available: () => true,
      refresh: async () => {
        refreshed = true
      },
      activate: async () => {
        throw new Error("module failure")
      },
    }).catch((error) => error)
    expect(String(result)).toContain("module failure")
    expect(refreshed).toBe(false)
  })

  test("does not reactivate a disabled extension or a server we left", async () => {
    for (const changeServer of [true, false]) {
      let current = manifest()
      let available = true
      let attempts = 0
      const active = await activateWithStyleRecovery({
        id: ID,
        current: () => current,
        available: () => available,
        refresh: async () => {
          if (changeServer) available = false
          else current = { ...current, enabled: false }
        },
        activate: async () => {
          attempts++
          throw new ExtensionStyleLoadError(ID, "index.css", "failed to load")
        },
      })
      expect(active).toBe(false)
      expect(attempts).toBe(1)
    }
  })
})
