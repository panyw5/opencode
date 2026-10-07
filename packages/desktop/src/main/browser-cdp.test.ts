import { describe, expect, mock, test } from "bun:test"

mock.module("./logging", () => ({ write: () => {} }))
const { BrowserCdp } = await import("./browser-cdp")

function fixture(options: { eligibleCount?: number; active?: boolean; nodeName?: string; attributes?: string[] } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let attached = false
  const debuggerAPI = {
    isAttached: () => attached,
    attach: () => {
      attached = true
    },
    on: () => {},
    sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } }
      if (method === "Runtime.evaluate" && params.returnByValue)
        return { result: { value: options.eligibleCount ?? 1 } }
      if (method === "Runtime.evaluate") return { result: { objectId: "current-file-input" } }
      if (method === "Runtime.callFunctionOn") return { result: { value: options.active ?? true } }
      if (method === "DOM.requestNode") return { nodeId: 2 }
      if (method === "DOM.resolveNode") return { object: { objectId: "element" } }
      if (method === "DOM.describeNode")
        return { node: { nodeName: options.nodeName ?? "INPUT", attributes: options.attributes ?? ["type", "file", "multiple", ""] } }
      return {}
    },
  }
  const browser = new BrowserCdp({
    id: 7,
    debugger: debuggerAPI,
  } as never)
  return { browser, calls }
}

describe("CDP file attachment", () => {
  test("uses DOM.setFileInputFiles only for one multiple file input", async () => {
    const f = fixture()
    await f.browser.setInputFiles('input[type="file"][aria-label="Attach files"]', ["/tmp/a.pdf", "/tmp/b.txt"])
    expect(f.calls.find((call) => call.method === "DOM.setFileInputFiles")?.params).toEqual({
      nodeId: 2,
      files: ["/tmp/a.pdf", "/tmp/b.txt"],
    })
  })
  test("rejects ambiguous selectors without dispatching file paths", async () => {
    const f = fixture({ eligibleCount: 2 })
    await expect(f.browser.setInputFiles('input[type="file"]', ["/tmp/a.pdf"])).rejects.toThrow("ambiguous")
    expect(f.calls.some((call) => call.method === "DOM.setFileInputFiles")).toBe(false)
  })
  test("ignores stale disabled matches and selects only one enabled current input", async () => {
    const f = fixture({ eligibleCount: 1 })
    await f.browser.setInputFiles('input[type="file"][aria-label="Attach files"]', ["/tmp/a.pdf"])
    const countQuery = f.calls.find((call) => call.method === "Runtime.evaluate")?.params.expression as string
    expect(countQuery).toContain("!input.disabled")
    expect(countQuery).toContain("[inert],[hidden],[aria-hidden")
    expect(f.calls.some((call) => call.method === "DOM.setFileInputFiles")).toBe(true)
  })
  test("rejects non-file controls and non-absolute paths", async () => {
    const wrongControl = fixture({ nodeName: "BUTTON", attributes: ["type", "button"] })
    await expect(wrongControl.browser.setInputFiles("button", ["/tmp/a.pdf"])).rejects.toThrow("not a file input")
    const invalidPath = fixture()
    await expect(invalidPath.browser.setInputFiles('input[type="file"]', ["a.pdf"])).rejects.toThrow("absolute")
    const disabled = fixture({ active: false })
    await expect(disabled.browser.setInputFiles('input[type="file"]', ["/tmp/a.pdf"])).rejects.toThrow("no longer enabled")
    expect(wrongControl.calls.some((call) => call.method === "DOM.setFileInputFiles")).toBe(false)
  })
  test("matches retry and regenerate labels without reading page content into the main process", async () => {
    const f = fixture()
    expect(await f.browser.matchesText("n2", "^(?:retry|try again|regenerate)$")).toBe(true)
    expect(f.calls.find((call) => call.method === "Runtime.callFunctionOn")?.params.arguments).toEqual([
      { value: "^(?:retry|try again|regenerate)$" },
    ])
  })
})
