import { describe, expect, test } from "bun:test"
import {
  activeInput,
  mentionCandidateMatches,
  mentionTokenMatches,
  openCodeComposerTarget,
  openCodeSendReadyExpression,
} from "./gpt-pro-ui-cases"

class MockCdpClient {
  calls: { method: string; params?: Record<string, unknown> }[] = []

  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params })
    let result: unknown = {}
    if (method === "DOM.getDocument") result = { root: { nodeId: 1 } }
    if (method === "Runtime.evaluate") result = { result: { objectId: "resolver-handle" } }
    if (method === "Runtime.callFunctionOn" && params?.returnByValue)
      result = {
        result: {
          value: {
            editorCount: 1,
            composerCount: 1,
            globalInputCount: 1,
            eligibleGlobalInputCount: 1,
            scopedInputCount: 1,
            reason: "ok",
          },
        },
      }
    if (method === "Runtime.callFunctionOn" && !params?.returnByValue)
      result = { result: { objectId: "input-handle" } }
    if (method === "DOM.requestNode") result = { nodeId: 2 }
    if (method === "DOM.describeNode")
      result = { node: { backendNodeId: 123, attributes: ["type", "file", "multiple", ""] } }
    return result as T
  }
}

class FixtureElement {
  parentElement: FixtureElement | null = null
  children: FixtureElement[] = []
  inputs: FixtureElement[] = []
  type = ""
  disabled = false
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()

  constructor(
    readonly name: string,
    readonly style: { display?: string; visibility?: string; contentVisibility?: string } = {},
  ) {}

  append(child: FixtureElement) {
    child.parentElement = this
    this.children.push(child)
    if (child.type === "file") this.inputs.push(child)
    this.inputs.push(...child.inputs)
    return child
  }

  getClientRects() {
    return this.style.display === "none" || this.style.visibility === "hidden" || this.style.contentVisibility === "hidden"
      ? []
      : [{}]
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, width: 10, height: 10 }
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }

  closest(selector: string) {
    if (selector === "[data-prompt-composer]") {
      for (let current: FixtureElement | null = this; current; current = current.parentElement) {
        if (current.attributes.has("data-prompt-composer")) return current
      }
    }
    if (selector.includes("[inert]")) {
      for (let current: FixtureElement | null = this; current; current = current.parentElement) {
        if (current.attributes.has("inert") || current.attributes.has("hidden") || current.attributes.get("aria-hidden") === "true")
          return current
      }
    }
    return null
  }

  querySelectorAll<T extends Element>(selector: string): T[] {
    if (selector === 'input[type="file"]') return this.inputs as unknown as T[]
    return []
  }

  querySelector(selector: string) {
    if (selector !== '[data-action="prompt-submit"]') return null
    return this.children.find((child) => child.attributes.get("data-action") === "prompt-submit") ?? null
  }
}

function withFixture<T>(input: {
  editors: FixtureElement[]
  inputs: FixtureElement[]
}, run: () => T) {
  const previousDocument = globalThis.document
  const previousGetComputedStyle = globalThis.getComputedStyle
  const fakeDocument = {
    body: new FixtureElement("body"),
    querySelectorAll(selector: string) {
      if (selector === '[data-component="prompt-input"][contenteditable="true"][role="textbox"]')
        return input.editors as unknown as Element[]
      if (selector === 'input[type="file"]') return input.inputs as unknown as Element[]
      return []
    },
  }
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument })
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: (element: FixtureElement) => ({
      display: element.style.display ?? "block",
      visibility: element.style.visibility ?? "visible",
      contentVisibility: element.style.contentVisibility ?? "visible",
    }),
  })
  try {
    return run()
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument })
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: previousGetComputedStyle })
  }
}

describe("OpenCode UI CDP composer resolver", () => {
  test("initializes the CDP document before resolving and identity-checking the input node", async () => {
    const client = new MockCdpClient()
    const input = await activeInput(client as never)
    const methods = client.calls.map((call) => call.method)
    expect(methods.indexOf("DOM.enable")).toBeLessThan(methods.indexOf("DOM.getDocument"))
    expect(methods.indexOf("DOM.getDocument")).toBeLessThan(methods.indexOf("DOM.requestNode"))
    expect(methods.indexOf("DOM.requestNode")).toBeLessThan(methods.indexOf("DOM.describeNode"))
    expect(input.backendNodeId).toBe(123)
    expect(input.nodeId).toBe(2)
    expect(input.multiple).toBe(true)
    expect(methods).toContain("Runtime.releaseObject")
  })

  test("matches file mention candidates without an @ label and verifies inserted tokens", () => {
    expect(mentionCandidateMatches("fixture-notes.md\n/", "fixture-notes.md")).toBe(true)
    expect(mentionCandidateMatches("中文 空格.png\n/", "中文")).toBe(true)
    expect(mentionTokenMatches("file", "/workspace/fixture-notes.md", "fixture-notes.md")).toBe(true)
    expect(mentionTokenMatches("agent", "explore", "explore")).toBe(true)
    expect(mentionTokenMatches("im", "fixture-notes.md", "fixture-notes.md")).toBe(false)
  })

  test("evaluates the serialized send guard against the active OpenCode composer", () => {
    const root = new FixtureElement("composer")
    root.attributes.set("data-prompt-composer", "main")
    const editor = root.append(new FixtureElement("editor"))
    const input = new FixtureElement("file-input")
    input.type = "file"
    root.append(input)
    const send = root.append(new FixtureElement("send"))
    send.attributes.set("data-action", "prompt-submit")
    const evaluate = new Function(`return ${openCodeSendReadyExpression()}`) as () => boolean
    const ready = withFixture({ editors: [editor], inputs: [input] }, evaluate)
    expect(ready).toBe(true)
    send.dataset.icon = "stop"
    expect(withFixture({ editors: [editor], inputs: [input] }, evaluate)).toBe(false)
  })

  test("scopes an OpenCode file input despite a ChatGPT-shaped decoy elsewhere", () => {
    const hiddenRoot = new FixtureElement("hidden-chatgpt", { display: "none" })
    const chatGPTInput = new FixtureElement("chatgpt-file-input")
    chatGPTInput.type = "file"
    chatGPTInput.attributes.set("aria-label", "Attach files")
    hiddenRoot.append(chatGPTInput)
    const activeRoot = new FixtureElement("opencode-composer")
    activeRoot.attributes.set("data-prompt-composer", "main")
    const editor = new FixtureElement("opencode-editor")
    editor.attributes.set("data-component", "prompt-input")
    const input = new FixtureElement("opencode-file-input")
    input.type = "file"
    activeRoot.append(editor)
    activeRoot.append(input)
    const target = withFixture({ editors: [editor], inputs: [chatGPTInput, input] }, () => openCodeComposerTarget())
    expect(target.reason).toBe("ok")
    expect(target.editor).toBe(editor)
    expect(target.composer).toBe(activeRoot)
    expect(target.input).toBe(input)
    expect(target.globalInputCount).toBe(2)
    expect(target.scopedInputCount).toBe(1)
  })

  test("ignores CSS-hidden composers and rejects scoped ambiguity", () => {
    const oldRoot = new FixtureElement("old-composer", { contentVisibility: "hidden" })
    const oldEditor = oldRoot.append(new FixtureElement("old-editor"))
    const oldInput = new FixtureElement("old-input")
    oldInput.type = "file"
    oldRoot.append(oldInput)
    const currentRoot = new FixtureElement("current-composer")
    currentRoot.attributes.set("data-prompt-composer", "main")
    const currentEditor = currentRoot.append(new FixtureElement("current-editor"))
    const activeInput1 = new FixtureElement("active-input-1")
    const activeInput2 = new FixtureElement("active-input-2")
    activeInput1.type = activeInput2.type = "file"
    currentRoot.append(activeInput1)
    currentRoot.append(activeInput2)
    const target = withFixture(
      { editors: [oldEditor, currentEditor], inputs: [oldInput, activeInput1, activeInput2] },
      () => openCodeComposerTarget(),
    )
    expect(target.editorCount).toBe(1)
    expect(target.reason).toBe("ambiguous-scoped-input")
    expect(target.scopedInputCount).toBe(2)
    expect(target.input).toBeNull()
  })

  test("rejects a ChatGPT-only editor and file input", () => {
    const chatGPTInput = new FixtureElement("chatgpt-file-input")
    chatGPTInput.type = "file"
    chatGPTInput.attributes.set("aria-label", "Attach files")
    const target = withFixture({ editors: [], inputs: [chatGPTInput] }, () => openCodeComposerTarget())
    expect(target.editorCount).toBe(0)
    expect(target.input).toBeNull()
    expect(target.reason).toBe("no-editor")
  })
})
