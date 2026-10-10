import { describe, expect, mock, test } from "bun:test"

mock.module("./logging", () => ({ write: () => {} }))
const { BrowserCdp } = await import("./browser-cdp")

function fixture(
  options: {
    eligibleCount?: number
    active?: boolean
    nodeName?: string
    attributes?: string[]
    axValues?: Array<string | number | boolean | undefined>
    composerBackendNodeIds?: number[]
    resolvedBackendNodeIds?: number[]
    resolvedHitResults?: boolean[]
    resolvedNodeName?: string
    failMouseMove?: boolean
  } = {},
) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let focusCount = 0
  let attached = false
  let resolverRun = 0
  let resolvedTargetRun = 0
  let resolvedHitCount = 0
  const debuggerAPI = {
    isAttached: () => attached,
    attach: () => {
      attached = true
    },
    on: () => {},
    sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && options.failMouseMove)
        throw new Error("simulated mouse move failure")
      if (method === "Accessibility.getFullAXTree")
        return {
          nodes: (options.axValues ?? []).map((value, index) => ({
            nodeId: String(index),
            backendDOMNodeId: index + 1,
            role: { value: "slider" },
            name: { value: "Effort" },
            ...(value === undefined ? {} : { value: { value } }),
          })),
        }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } }
      if (method === "Runtime.evaluate" && params.expression === "composer-resolver-fixture") {
        resolverRun++
        return { result: { objectId: `resolver-${resolverRun}` } }
      }
      if (method === "Runtime.evaluate" && params.expression === "send-target-fixture") {
        resolvedTargetRun++
        return { result: { objectId: `send-target-${resolvedTargetRun}` } }
      }
      if (
        method === "Runtime.callFunctionOn" &&
        /^resolver-\d+$/.test(String(params.objectId)) &&
        String(params.functionDeclaration).includes("editorCount:this.editorCount")
      )
        return {
          result: {
            value: { editorCount: 1, globalInputCount: 2, eligibleGlobalInputCount: 2, scopedInputCount: 1, reason: "ok" },
          },
        }
      if (
        method === "Runtime.callFunctionOn" &&
        /^resolver-\d+$/.test(String(params.objectId)) &&
        String(params.functionDeclaration).includes("return this.input")
      )
        return { result: { objectId: `resolver-input-${String(params.objectId).slice("resolver-".length)}` } }
      if (method === "DOM.requestNode" && String(params.objectId).startsWith("resolver-input-"))
        return { nodeId: 100 + Number(String(params.objectId).slice("resolver-input-".length)) }
      if (method === "DOM.requestNode" && String(params.objectId).startsWith("send-target-"))
        return { nodeId: 300 + Number(String(params.objectId).slice("send-target-".length)) }
      if (method === "DOM.describeNode" && Number(params.nodeId) >= 301 && Number(params.nodeId) < 400) {
        const run = Number(params.nodeId) - 300
        return {
          node: {
            backendNodeId: options.resolvedBackendNodeIds?.[run - 1] ?? 31,
            nodeName: options.resolvedNodeName ?? "BUTTON",
            attributes: ["type", "submit"],
          },
        }
      }
      if (method === "Runtime.callFunctionOn" && String(params.objectId).startsWith("send-target-")) {
        const result = options.resolvedHitResults?.[resolvedHitCount++] ?? true
        return { result: { value: result ? { x: 40, y: 50 } : null } }
      }
      if (method === "DOM.describeNode" && Number(params.nodeId) >= 101) {
        const run = Number(params.nodeId) - 100
        return {
          node: {
            backendNodeId: options.composerBackendNodeIds?.[run - 1] ?? 21,
            nodeName: "INPUT",
            attributes: ["type", "file", "multiple", "", "aria-label", "Attach files"],
          },
        }
      }
      if (method === "Runtime.evaluate" && params.returnByValue)
        return { result: { value: options.eligibleCount ?? 1 } }
      if (method === "Runtime.evaluate") return { result: { objectId: "current-file-input" } }
      if (method === "Runtime.callFunctionOn") return { result: { value: options.active ?? true } }
      if (method === "DOM.requestNode") return { nodeId: 2 }
      if (method === "DOM.resolveNode") return { object: { objectId: "element" } }
      if (method === "DOM.getBoxModel")
        return { model: { content: [0, 0, 100, 0, 100, 100, 0, 100] } }
      if (method === "DOM.describeNode")
        return {
          node: {
            nodeName: options.nodeName ?? "INPUT",
            attributes: options.attributes ?? ["type", "file", "multiple", ""],
          },
        }
      return {}
    },
  }
  const browser = new BrowserCdp({
    id: 7,
    debugger: debuggerAPI,
    getURL: () => "https://chatgpt.com/",
    getTitle: () => "ChatGPT",
    focus: () => {
      focusCount++
    },
    isLoading: () => false,
  } as never)
  return { browser, calls, focusCount: () => focusCount }
}

describe("CDP file attachment", () => {
  test("applies an explicit non-mobile layout viewport without focusing the page", async () => {
    const f = fixture()
    await f.browser.setViewport(1280, 800)
    const metrics = f.calls.find((call) => call.method === "Emulation.setDeviceMetricsOverride")
    expect(metrics?.params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    const metricsIndex = f.calls.findIndex((call) => call.method === "Emulation.setDeviceMetricsOverride")
    const focusEmulationIndex = f.calls.findIndex((call) => call.method === "Emulation.setFocusEmulationEnabled")
    expect(focusEmulationIndex).toBe(metricsIndex + 1)
    expect(f.calls[focusEmulationIndex].params).toEqual({ enabled: true })
    expect(f.calls.findIndex((call) => call.method === "Runtime.enable")).toBeLessThan(metricsIndex)
    expect(f.focusCount()).toBe(0)
    await expect(f.browser.setViewport(0, 800)).rejects.toThrow("positive integers")
  })

  test("clicks the exact resolver button only after stable backend identity and hit tests", async () => {
    const f = fixture({ resolvedBackendNodeIds: [31, 31] })
    let prepared = 0
    let committed = 0
    let commitCallCount = 0
    await f.browser.clickResolved("send-target-fixture", async () => {
      prepared++
      return () => {
        commitCallCount = f.calls.length
        committed++
      }
    })
    expect(prepared).toBe(1)
    expect(committed).toBe(1)
    expect(f.calls.filter((call) => call.method === "Runtime.evaluate" && call.params.expression === "send-target-fixture")).toHaveLength(3)
    expect(f.calls.filter((call) => call.method === "Runtime.callFunctionOn" && String(call.params.objectId).startsWith("send-target-")).length).toBe(3)
    expect(commitCallCount).toBeGreaterThan(0)
    expect(commitCallCount).toBe(f.calls.findIndex((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed"))
    expect(f.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ])
    expect(f.focusCount()).toBe(0)
  })
  test("rejects covered or replaced resolver buttons without mouse dispatch", async () => {
    const covered = fixture({ resolvedHitResults: [false] })
    let coveredPrepared = 0
    let coveredCommitted = 0
    await expect(
      covered.browser.clickResolved("send-target-fixture", async () => {
        coveredPrepared++
        return () => coveredCommitted++
      }),
    ).rejects.toThrow("covered")
    expect(coveredPrepared).toBe(0)
    expect(coveredCommitted).toBe(0)
    expect(covered.calls.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false)

    const replaced = fixture({ resolvedBackendNodeIds: [31, 32] })
    let replacementPrepared = 0
    let replacementCommitted = 0
    await expect(
      replaced.browser.clickResolved("send-target-fixture", async () => {
        replacementPrepared++
        return () => replacementCommitted++
      }),
    ).rejects.toThrow("changed before dispatch")
    expect(replacementPrepared).toBe(1)
    expect(replacementCommitted).toBe(0)
    expect(replaced.calls.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false)

    const newlyCovered = fixture({ resolvedHitResults: [true, true, false] })
    let coveredAfterGuardCommitted = 0
    await expect(
      newlyCovered.browser.clickResolved("send-target-fixture", async () => () => coveredAfterGuardCommitted++),
    ).rejects.toThrow("covered")
    expect(coveredAfterGuardCommitted).toBe(0)
    expect(newlyCovered.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type)).toEqual([
      "mouseMoved",
    ])
  })
  test("a failed mouse move never commits send intent or presses the control", async () => {
    const f = fixture({ resolvedBackendNodeIds: [31, 31], failMouseMove: true })
    let committed = 0
    await expect(
      f.browser.clickResolved("send-target-fixture", async () => () => committed++),
    ).rejects.toThrow("simulated mouse move failure")
    expect(committed).toBe(0)
    expect(f.calls.some((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed")).toBe(
      false,
    )

    const uid = fixture({ failMouseMove: true })
    let uidCommitted = 0
    await expect(uid.browser.click("n31", undefined, async () => () => uidCommitted++)).rejects.toThrow(
      "simulated mouse move failure",
    )
    expect(uidCommitted).toBe(0)
    expect(uid.calls.some((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed")).toBe(
      false,
    )
  })
  test("matches a recovery UID only to the exact current resolver button", async () => {
    const f = fixture({ resolvedBackendNodeIds: [31, 31] })
    expect(await f.browser.matchesResolved("n31", "send-target-fixture")).toBe(true)
    expect(await f.browser.matchesResolved("n32", "send-target-fixture")).toBe(false)
  })
  test("UID click commits only after its exact element passes the final hit test", async () => {
    const f = fixture()
    let prepared = 0
    let committed = 0
    let commitCallCount = 0
    await f.browser.click("n31", undefined, async () => {
      prepared++
      return () => {
        commitCallCount = f.calls.length
        committed++
      }
    })
    expect(prepared).toBe(1)
    expect(committed).toBe(1)
    expect(commitCallCount).toBe(f.calls.findIndex((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed"))
    expect(f.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ])
  })

  test("normalizes accessibility scalar values for every control, not per website", async () => {
    const f = fixture({ axValues: [2, 0, false, true, "Pro", undefined] })
    const snapshot = await f.browser.snapshot()
    expect(snapshot.nodes.map((node) => node.value)).toEqual(["2", "0", "false", "true", "Pro", undefined])
  })
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
  test("re-resolves the composer input at dispatch and rejects a stale replacement", async () => {
    const stable = fixture({ composerBackendNodeIds: [21, 21] })
    let dispatched = false
    await stable.browser.setInputFiles(
      'input[type="file"][aria-label="Attach files"]',
      ["/tmp/a.pdf"],
      "composer-resolver-fixture",
      async () => {
        dispatched = true
      },
    )
    expect(dispatched).toBe(true)
    expect(stable.calls.filter((call) => call.method === "Runtime.evaluate" && call.params.expression === "composer-resolver-fixture")).toHaveLength(2)
    expect(stable.calls.find((call) => call.method === "DOM.setFileInputFiles")?.params.nodeId).toBe(102)
    expect(stable.calls.filter((call) => call.method === "Runtime.releaseObject")).toHaveLength(4)

    const replaced = fixture({ composerBackendNodeIds: [21, 22] })
    let staleDispatch = false
    await expect(
      replaced.browser.setInputFiles(
        'input[type="file"][aria-label="Attach files"]',
        ["/tmp/a.pdf"],
        "composer-resolver-fixture",
        async () => {
          staleDispatch = true
        },
      ),
    ).rejects.toThrow("changed before file dispatch")
    expect(staleDispatch).toBe(false)
    expect(replaced.calls.some((call) => call.method === "DOM.setFileInputFiles")).toBe(false)
  })
  test("ignores stale disabled matches and selects only one enabled current input", async () => {
    const f = fixture({ eligibleCount: 1 })
    await f.browser.setInputFiles('input[type="file"][aria-label="Attach files"]', ["/tmp/a.pdf"])
    const countQuery = f.calls.find((call) => call.method === "Runtime.evaluate")?.params.expression as string
    expect(countQuery).toContain("!input.disabled")
    expect(countQuery).toContain("[inert],[hidden],[aria-hidden")
    expect(f.calls.some((call) => call.method === "DOM.setFileInputFiles")).toBe(true)
  })
  test("re-resolves the active composer immediately before dispatch and rejects a replaced input", async () => {
    const stable = fixture({ composerBackendNodeIds: [21, 21] })
    await stable.browser.setInputFiles("input[type=file]", ["/tmp/chart.png"], "composer-resolver-fixture")
    expect(stable.calls.filter((call) => call.method === "Runtime.evaluate" && call.params.expression === "composer-resolver-fixture")).toHaveLength(2)
    expect(stable.calls.find((call) => call.method === "DOM.setFileInputFiles")?.params.nodeId).toBe(102)

    const replaced = fixture({ composerBackendNodeIds: [21, 22] })
    await expect(
      replaced.browser.setInputFiles("input[type=file]", ["/tmp/chart.png"], "composer-resolver-fixture"),
    ).rejects.toThrow("changed before file dispatch")
    expect(replaced.calls.some((call) => call.method === "DOM.setFileInputFiles")).toBe(false)
  })
  test("rejects non-file controls and non-absolute paths", async () => {
    const wrongControl = fixture({ nodeName: "BUTTON", attributes: ["type", "button"] })
    await expect(wrongControl.browser.setInputFiles("button", ["/tmp/a.pdf"])).rejects.toThrow("not a file input")
    const invalidPath = fixture()
    await expect(invalidPath.browser.setInputFiles('input[type="file"]', ["a.pdf"])).rejects.toThrow("absolute")
    const disabled = fixture({ active: false })
    await expect(disabled.browser.setInputFiles('input[type="file"]', ["/tmp/a.pdf"])).rejects.toThrow(
      "no longer enabled",
    )
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
