import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  inspectChatGptPage,
  CHATGPT_INSPECT_EXPRESSION,
  CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION,
  CHATGPT_ONBOARDING_DISMISS_EXPRESSION,
} from "@opencode-ai/util/chatgpt-page"
import { createHash } from "node:crypto"

const originalRects = Element.prototype.getClientRects
let originalUrl = ""
let originalFetch: typeof window.fetch

beforeEach(() => {
  originalUrl = window.location.href
  originalFetch = window.fetch
  Element.prototype.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList
  ;(window as any).happyDOM.setURL("https://chatgpt.com/")
  document.body.innerHTML =
    '<button data-testid="model-switcher-dropdown-button">GPT-6 Pro</button><div id="prompt-textarea" contenteditable="true"></div><main></main>'
  document.title = "ChatGPT"
})

afterEach(() => {
  const tracking = (window as any).__opencodeGptProTracking
  tracking?.stop()
  delete (window as any).__opencodeGptProTracking
  delete (window as any).__opencodeGptProImageDigestCache
  window.fetch = originalFetch
  Element.prototype.getClientRects = originalRects
  document.body.innerHTML = ""
  ;(window as any).happyDOM.setURL(originalUrl)
})

function conversation(html: string, complete = true) {
  document.querySelector("main")!.innerHTML =
    `<article><div data-message-author-role="user" data-message-id="u1">Question</div></article><article><div data-message-author-role="assistant" data-message-id="a1"><div class="markdown">${html}</div></div>${complete ? '<button data-testid="copy-turn-action-button">Copy</button>' : ""}</article>`
}

function composerBlobImage(url: string) {
  document.getElementById("prompt-textarea")?.remove()
  const body = document.createElement("div")
  body.setAttribute("data-composer-body", "")
  body.innerHTML = `
    <div id="prompt-textarea" contenteditable="true"></div>
    <div data-composer-attachments data-visible-attachments>
      <div class="flex-wrap"><div class="group/composer-attachment" role="button" aria-label="chart.png" aria-haspopup="dialog" aria-expanded="false">
        <img alt="thumbnail" src="${url}"><button aria-label="Remove chart.png"></button>
      </div></div>
    </div>`
  document.body.append(body)
  const image = body.querySelector<HTMLImageElement>("img")!
  let currentSrc = url
  Object.defineProperty(image, "complete", { configurable: true, value: true })
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 1 })
  Object.defineProperty(image, "currentSrc", { configurable: true, get: () => currentSrc })
  return {
    image,
    setCurrentSrc(value: string) {
      currentSrc = value
      image.setAttribute("src", value)
    },
  }
}

function blobResponse(url: string, chunks: Uint8Array[], contentLength?: number) {
  let index = 0
  return {
    ok: true,
    url,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "content-type") return "image/png"
        if (name.toLowerCase() === "content-length" && contentLength !== undefined) return String(contentLength)
        return null
      },
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++])
        else controller.close()
      },
    }),
  }
}

describe("ChatGPT reply HTML extraction", () => {
  test("inspects image attachment hashes without returning image bytes or contaminating prompt text", async () => {
    const bytes = Buffer.from("private image fixture")
    const base64 = bytes.toString("base64")
    document.querySelector("main")!.innerHTML = `
      <div data-message-author-role="user" data-message-id="u1">
        <div data-user-message-bubble>Review this image</div>
        <div class="group/resource-card"><button type="button" aria-label="report.pdf" aria-busy="false"></button><span class="truncate" title="report.pdf">report.pdf</span></div>
        <div role="button" aria-label="User attachment">
          <img alt="User attachment" aria-expanded="false" data-state="closed" src="data:image/png;base64,${base64}">
        </div>
      </div>`
    const image = document.querySelector<HTMLImageElement>('img[alt="User attachment"]')!
    Object.defineProperty(image, "complete", { configurable: true, value: true })
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 1 })
    const page = inspectChatGptPage(10000)
    expect(page.users[0]).toEqual({
      id: "u1",
      text: "Review this image",
      attachments: [{ name: "report.pdf", kind: "document", status: "ready" }],
    })
    const evidence = await window.eval(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
    expect(evidence.users[0]).toEqual({
      id: "u1",
      attachments: [{ name: "", kind: "image", sha256: createHash("sha256").update(bytes).digest("hex"), status: "ready" }],
    })
    expect(JSON.stringify(evidence)).not.toContain(base64)
  })
  test("recognizes a ready composer image preview by its rendered bytes", async () => {
    const bytes = Buffer.from("composer image fixture")
    const base64 = bytes.toString("base64")
    document.getElementById("prompt-textarea")?.remove()
    const body = document.createElement("div")
    body.setAttribute("data-composer-body", "")
    body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-composer-attachments data-visible-attachments>
        <div class="flex-wrap">
          <span class="group/composer-attachment">
            <span class="truncate">report.pdf</span>
            <button type="button" aria-label="report.pdf" aria-busy="false"></button>
            <img alt="" data-attachment-thumbnail-state="ready" src="data:image/png;base64,${base64}">
            <button aria-label="Remove report.pdf"></button>
          </span>
          <div class="group/composer-attachment" role="button" aria-label="chart.png" aria-haspopup="dialog" aria-expanded="false">
            <img alt="thumbnail preview" src="data:image/png;base64,${base64}">
            <button aria-label="Remove chart.png"></button>
          </div>
        </div>
      </div>`
    document.body.append(body)
    const image = body.querySelector<HTMLImageElement>('[alt="thumbnail preview"]')!
    Object.defineProperty(image, "complete", { configurable: true, value: true })
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 1 })
    const page = inspectChatGptPage(10000)
    expect(page.attachments).toEqual([
      { name: "report.pdf", status: "ready" },
      { name: "chart.png", status: "unknown" },
    ])
    const evidence = await window.eval(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
    expect(evidence.composer).toEqual([
      { name: "chart.png", kind: "image", sha256: createHash("sha256").update(bytes).digest("hex"), status: "ready" },
    ])
  })
  test("leaves non-data or unrecognized image previews unknown", async () => {
    document.getElementById("prompt-textarea")?.remove()
    const body = document.createElement("div")
    body.setAttribute("data-composer-body", "")
    body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-composer-attachments data-visible-attachments>
        <div class="flex-wrap"><div class="group/composer-attachment" role="button" aria-label="chart.png" aria-haspopup="dialog" aria-expanded="false">
          <img alt="chart.png" src="https://example.invalid/chart.png"><button aria-label="Remove chart.png"></button>
        </div></div>
      </div>`
    document.body.append(body)
    const image = body.querySelector<HTMLImageElement>("img")!
    Object.defineProperty(image, "complete", { configurable: true, value: true })
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 1 })
    const evidence = await window.eval(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
    expect(evidence.composer).toEqual([{ name: "chart.png", kind: "image", status: "unknown" }])
  })
  test("hashes only observed same-origin blob previews with credentials omitted", async () => {
    const bytes = Buffer.from("original blob image bytes")
    const url = "blob:https://chatgpt.com/upload-1"
    composerBlobImage(url)
    let calls = 0
    ;(window as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++
      expect(String(input)).toBe(url)
      expect(init?.credentials).toBe("omit")
      expect(init?.mode).toBe("same-origin")
      return blobResponse(url, [bytes]) as Response
    }
    const evidence = await window.eval(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
    expect(calls).toBe(1)
    expect(evidence.composer).toEqual([
      { name: "chart.png", kind: "image", sha256: createHash("sha256").update(bytes).digest("hex"), status: "ready" },
    ])
    expect(JSON.stringify(evidence)).not.toContain(bytes.toString("base64"))
  })
  test("never fetches cross-origin blob or HTTP image URLs", async () => {
    let calls = 0
    ;(window as any).fetch = async () => {
      calls++
      throw new Error("untrusted image fetch attempted")
    }
    for (const url of ["blob:https://elsewhere.invalid/x", "https://chatgpt.com/image.png"]) {
      composerBlobImage(url)
      const evidence = await window.eval(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
      expect(evidence.composer).toEqual([{ name: "chart.png", kind: "image", status: "unknown" }])
    }
    expect(calls).toBe(0)
  })
  test("rejects oversized blob content before hashing and enforces the streaming cap", async () => {
    const url = "blob:https://chatgpt.com/oversized"
    composerBlobImage(url)
    let reads = 0
    ;(window as any).fetch = async () => ({
      ok: true,
      url,
      headers: { get: (name: string) => name.toLowerCase() === "content-length" ? String(20 * 1024 * 1024 + 1) : "image/png" },
      body: { getReader: () => { reads++; throw new Error("oversized body should not be read") } },
    }) as unknown as Response
    let evidence = await window.eval(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
    expect(evidence.composer[0].status).toBe("unknown")
    expect(reads).toBe(0)

    const second = "blob:https://chatgpt.com/stream-overflow"
    composerBlobImage(second)
    ;(window as any).fetch = async () =>
      blobResponse(second, [new Uint8Array(10 * 1024 * 1024), new Uint8Array(10 * 1024 * 1024 + 1)]) as Response
    evidence = await window.eval(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
    expect(evidence.composer[0].status).toBe("unknown")
  })
  test("aborts timed-out blob reads and discards hashes after the image source changes", async () => {
    const timeoutURL = "blob:https://chatgpt.com/timeout"
    composerBlobImage(timeoutURL)
    const oldSetTimeout = window.setTimeout
    let evidence: any
    window.setTimeout = ((callback: TimerHandler, delay?: number) => {
      if (delay === 8000 && typeof callback === "function") {
        callback()
        return 101
      }
      return oldSetTimeout(callback, delay)
    }) as typeof window.setTimeout
    try {
      ;(window as any).fetch = async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) reject(new DOMException("Aborted", "AbortError"))
          else init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        }) as Promise<Response>
      evidence = await window.eval(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
      expect(evidence.composer[0].status).toBe("unknown")
    } finally {
      window.setTimeout = oldSetTimeout
    }

    const changedURL = "blob:https://chatgpt.com/source-change"
    const fixture = composerBlobImage(changedURL)
    let finish!: (response: Response) => void
    ;(window as any).fetch = async () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const pending = window.eval(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 0))
    fixture.setCurrentSrc("blob:https://chatgpt.com/replaced")
    const bytes = Buffer.from("old image source")
    finish(blobResponse(changedURL, [bytes]) as Response)
    evidence = await pending
    expect(evidence.composer[0].status).toBe("unknown")
  })
  test("reads multiline ProseMirror paragraphs without layout-generated extra newlines", () => {
    document.getElementById("prompt-textarea")!.innerHTML =
      '<p>Research question?</p><p data-empty-paragraph="true"><br class="ProseMirror-trailingBreak"></p><p>Please cover:</p><p>1. First topic</p><p>2. Second topic</p><p data-empty-paragraph="true"><br class="ProseMirror-trailingBreak"></p><p>Use $F^\\dagger F$ and citations.</p>'
    const expected =
      "Research question?\n\nPlease cover:\n1. First topic\n2. Second topic\n\nUse $F^\\dagger F$ and citations."
    expect(inspectChatGptPage(10000).draft).toBe(expected)
    expect(window.eval(CHATGPT_INSPECT_EXPRESSION).draft).toBe(expected)
  })
  test("preserves inline line breaks and actual whitespace rather than collapsing them", () => {
    document.getElementById("prompt-textarea")!.innerHTML =
      '<p>First<br>Second<br class="ProseMirror-trailingBreak"></p><p>Indented:  x</p><p>Last</p>'
    expect(inspectChatGptPage(10000).draft).toBe("First\nSecond\nIndented:  x\nLast")
  })
  test("uses textarea value rather than layout text for the legacy composer", () => {
    document.getElementById("prompt-textarea")!.outerHTML = '<textarea id="prompt-textarea"></textarea>'
    document.querySelector("textarea")!.value = "First\r\n\r\nSecond"
    expect(inspectChatGptPage(10000).draft).toBe("First\n\nSecond")
  })
  test("matches the full submitted prompt without folded-message ellipsis and Show more controls", () => {
    const prompt =
      "Long question\n\n1. First topic\n2. Second topic\n\nDo not remove literal Show more from this sentence."
    document.querySelector("main")!.innerHTML =
      '<div data-message-author-role="user" data-message-id="u1"><div data-user-message-bubble><div data-search-result-target style="max-height:40px;overflow:hidden"><div class="whitespace-pre-wrap"></div></div><span aria-hidden="true">…</span><button data-markdown-copy="exclude">Show more</button></div></div>'
    document.querySelector(".whitespace-pre-wrap")!.textContent = prompt
    expect(inspectChatGptPage(10000).users).toEqual([{ id: "u1", text: prompt }])
    expect(window.eval(CHATGPT_INSPECT_EXPRESSION).users).toEqual([{ id: "u1", text: prompt }])
  })
  test("excludes message actions even when there is no search-target wrapper", () => {
    document.querySelector("main")!.innerHTML =
      '<div data-message-author-role="user" data-message-id="u1"><div data-user-message-bubble>Question<button>Show less</button><span aria-hidden="true">…</span></div></div>'
    expect(inspectChatGptPage(10000).users).toEqual([{ id: "u1", text: "Question" }])
  })
  test("finds only a feature introduction's explicit dismissal control", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="dialog"><h2>Introducing new features</h2><button aria-label="Close"></button></div>',
    )
    const dismissal = window.eval(CHATGPT_ONBOARDING_DISMISS_EXPRESSION)
    expect(dismissal.heading).toBe("Introducing new features")
    expect(document.querySelector(dismissal.selector)?.getAttribute("aria-label")).toBe("Close")
  })
  test("does not dismiss authentication, consent, unknown or hidden dialogs", () => {
    for (const body of [
      '<div role="dialog"><h2>Introducing new features</h2><p>Sign in to continue</p><button>Close</button></div>',
      '<div role="dialog"><h2>Permission required</h2><button>OK</button></div>',
      '<div role="dialog"><h2>Something else</h2><button>Close</button></div>',
      '<div role="dialog" aria-hidden="true"><h2>Introducing new features</h2><button>Close</button></div>',
    ]) {
      document.body.innerHTML = body
      expect(window.eval(CHATGPT_ONBOARDING_DISMISS_EXPRESSION)).toBeNull()
      expect(document.querySelector("[data-opencode-gpt-pro-dismiss]")).toBeNull()
    }
  })
  test("requires one visible enabled send control", () => {
    expect(inspectChatGptPage(10000).sendReady).toBe(false)
    document.body.insertAdjacentHTML("beforeend", '<button aria-label="Send prompt" disabled></button>')
    expect(inspectChatGptPage(10000).sendReady).toBe(false)
    document.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!.disabled = false
    expect(inspectChatGptPage(10000).sendReady).toBe(true)
    document.body.insertAdjacentHTML("beforeend", '<button data-testid="send-button"></button>')
    expect(inspectChatGptPage(10000).sendReady).toBe(false)
  })
  test("detects request errors beside Retry without accepting them as replies", () => {
    conversation("<p>Old partial answer</p>", false)
    document
      .querySelector("main")!
      .insertAdjacentHTML("beforeend", "<div><div>Unknown error</div><div><button>Retry</button></div></div>")
    expect(inspectChatGptPage(10000).error?.kind).toBe("request")
    expect(inspectChatGptPage(10000).answer?.complete).toBe(false)
  })
  test("classifies an inline Cloudflare challenge as human verification", () => {
    document.querySelector("main")!.innerHTML = `
      <div data-message-author-role="user" data-message-id="u1">
        <div data-user-message-bubble>Read my attachment</div>
      </div>
      <div class="flex min-w-0 grow flex-col">
        <div class="flex min-w-0 flex-1 flex-col"><div class="min-w-0 flex-1">cloudflare_challenge</div></div>
        <div class="flex gap-2"><button type="button">Retry</button></div>
      </div>`
    expect(inspectChatGptPage(10000).error?.kind).toBe("verification")
  })
  test("does not treat challenge text quoted in a prompt or answer as browser verification", () => {
    document.querySelector("main")!.innerHTML =
      '<div data-message-author-role="user" data-message-id="u1"><div data-user-message-bubble>cloudflare_challenge<button>Retry</button></div></div>'
    expect(inspectChatGptPage(10000).error).toBeUndefined()
    conversation('<p>cloudflare_challenge</p><button>Retry</button>')
    expect(inspectChatGptPage(10000).error).toBeUndefined()
  })
  test("does not treat quoted errors or hidden failures as a website rejection", () => {
    conversation("<p>Unknown error</p><button>Retry</button>")
    document.body.insertAdjacentHTML("beforeend", "<main inert><div>Unknown error<button>Retry</button></div></main>")
    expect(inspectChatGptPage(10000).error).toBeUndefined()
  })
  test("reports browser verification before the composer exists", () => {
    document.body.innerHTML = "<main></main>"
    document.title = "Just a moment..."
    expect(inspectChatGptPage(10000).error?.kind).toBe("verification")
  })
  test("ignores the retained hidden homepage and extracts current search-unit messages", () => {
    document.body.innerHTML =
      '<button data-testid="model-switcher-dropdown-button">GPT-6 Pro</button><main inert><div data-message-author-role="user">Old hidden question</div></main><main><div class="group flex flex-col"><div data-chatgpt-search-unit-key="turn:0:user" data-chatgpt-search-message-ids="u1"><div data-user-message-bubble>Question</div></div><div data-chatgpt-search-unit-key="turn:1:reasoning">Thinking</div><div data-chatgpt-search-unit-key="turn:2:assistant" data-chatgpt-search-message-ids="a1 a1"><div data-markdown-text-style="assistant-message"><p>Answer</p></div></div><button aria-label="Regenerate response"></button></div></main>'
    const page = inspectChatGptPage(10000)
    expect(page.users).toEqual([{ id: "u1", text: "Question" }])
    expect(page.answer?.id).toBe("a1")
    expect(page.answer?.html).toBe("<p>Answer</p>")
    expect(page.answer?.complete).toBe(true)
  })
  test("current Chat UI recognizes the actual composer and verified 6 / Pro row", () => {
    document.body.innerHTML =
      '<button aria-label="Select ChatGPT model" aria-controls="model-menu" data-selected-reasoning-effort="medium">Pro</button><div role="textbox" contenteditable="true" data-composer-markdown></div><main></main><div role="menu" id="model-menu"><div data-model-picker-view-toggle aria-hidden="false">6 Pro</div></div>'
    expect(inspectChatGptPage(10000).targetModel).toBe(true)
    expect(inspectChatGptPage(10000).composer).toBe(true)
    document.getElementById("model-menu")!.remove()
    expect(inspectChatGptPage(10000).targetModel).toBe(true)
  })
  test("a bare Pro trigger is not proof of GPT-6", () => {
    document.body.innerHTML = '<button aria-label="Select ChatGPT model">Pro</button><main></main>'
    expect(inspectChatGptPage(10000).targetModel).toBe(false)
  })
  test("recognizes the live view-track structure while the trigger says Thinking effort", () => {
    document.body.innerHTML =
      '<button aria-label="Select ChatGPT model" aria-controls="model-menu" data-selected-reasoning-effort="medium">Thinking effort</button><main></main><div role="menu" id="model-menu"><div aria-hidden="true" inert><div data-model-picker-view-toggle>5.5 Pro</div></div><div aria-hidden="false"><div data-model-picker-view-toggle>6\nPro</div></div></div>'
    expect(inspectChatGptPage(10000).model).toBe("GPT-6 Pro")
    expect(window.eval(CHATGPT_INSPECT_EXPRESSION).targetModel).toBe(true)
    document.getElementById("model-menu")!.remove()
    document.querySelector("button")!.textContent = "Pro"
    expect(inspectChatGptPage(10000).targetModel).toBe(true)
  })
  test("does not verify hidden Pro rows or ambiguous visible rows", () => {
    document.body.innerHTML =
      '<button aria-label="Select ChatGPT model" aria-controls="model-menu">Thinking effort</button><main></main><div role="menu" id="model-menu"><div aria-hidden="true"><div data-model-picker-view-toggle>6 Pro</div></div><div data-model-picker-view-toggle>6 High</div></div>'
    expect(inspectChatGptPage(10000).targetModel).toBe(false)
    document
      .getElementById("model-menu")!
      .insertAdjacentHTML("beforeend", "<div data-model-picker-view-toggle>6 Pro</div>")
    expect(inspectChatGptPage(10000).targetModel).toBe(false)
  })
  test("re-associates the sole visible model picker while aria-controls is being replaced", () => {
    document.body.innerHTML =
      '<button aria-label="Select ChatGPT model" aria-expanded="true">Pro</button><main></main><div role="menu"><div data-model-picker-view-toggle aria-hidden="false">6 Pro</div></div>'
    expect(inspectChatGptPage(10000).targetModel).toBe(true)
  })
  test("model evidence is invalidated if the trigger identity or effort changes", () => {
    document.body.innerHTML =
      '<button aria-label="Select ChatGPT model" aria-controls="model-menu" data-selected-reasoning-effort="medium">Pro</button><main></main><div id="model-menu"><div data-model-picker-view-toggle aria-hidden="false">6 Pro</div></div>'
    expect(inspectChatGptPage(10000).targetModel).toBe(true)
    document.getElementById("model-menu")!.remove()
    document.querySelector("button")!.setAttribute("data-selected-reasoning-effort", "low")
    expect(inspectChatGptPage(10000).targetModel).toBe(false)
  })
  test("serialized browser code is self-contained", () => {
    conversation("<p>Answer</p>")
    const page = window.eval(CHATGPT_INSPECT_EXPRESSION)
    expect(page.model).toBe("GPT-6 Pro")
    expect(page.answer.html).toBe("<p>Answer</p>")
  })
  test("only recognizes the selected model, not a Pro label elsewhere", () => {
    document.querySelector('[data-testid="model-switcher-dropdown-button"]')!.textContent = "GPT-5.5 Pro"
    document.body.insertAdjacentHTML("beforeend", "<div>GPT-6 Pro</div>")
    expect(inspectChatGptPage(10000).targetModel).toBe(false)
  })

  test("keeps tables, code and math and associates the answer with its question", () => {
    conversation(
      '<p>Answer</p><table><tr><td>value</td></tr></table><pre><code>const n = 1</code></pre><span class="katex"><math><mi>x</mi></math></span>',
    )
    const result = inspectChatGptPage(10000)
    expect(result.answer?.id).toBe("a1")
    expect(result.answer?.userID).toBe("u1")
    expect(result.answer?.html).toContain("<table>")
    expect(result.answer?.html).toContain("<code>")
    expect(result.answer?.html).toContain("<math>")
    expect(result.answer?.complete).toBe(true)
  })

  test("does not return an old reply before the last question", () => {
    conversation("<p>Old answer</p>")
    document
      .querySelector("main")!
      .insertAdjacentHTML(
        "beforeend",
        '<article><div data-message-author-role="user" data-message-id="u2">New question</div></article>',
      )
    expect(inspectChatGptPage(10000).answer).toBeUndefined()
  })

  test("ignores message-like nodes outside the conversation", () => {
    conversation("<p>Real answer</p>")
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-message-author-role="assistant"><div class="markdown">Sidebar</div></div>',
    )
    expect(inspectChatGptPage(10000).answer?.text).toBe("Real answer")
  })

  test("does not mark a reply complete while generating", () => {
    conversation("<p>Partial answer</p>")
    document.body.insertAdjacentHTML("beforeend", '<button data-testid="stop-button">Stop</button>')
    const result = inspectChatGptPage(10000)
    expect(result.generating).toBe(true)
    expect(result.answer?.complete).toBe(false)
  })

  test("requires a completion control, not merely stable HTML", () => {
    conversation("<p>Partial answer</p>", false)
    expect(inspectChatGptPage(10000).answer?.complete).toBe(false)
  })

  test("refuses ambiguous reasoning and final-answer regions", () => {
    conversation('<div class="markdown">Reasoning</div><p>Answer</p>')
    expect(inspectChatGptPage(10000).answer).toBeUndefined()
  })

  test("removes SVG animation that could restore an executable link", () => {
    conversation(
      '<p>Answer</p><svg><a href="https://example.com"><animate attributeName="href" values="javascript:alert(1)" /></a></svg>',
    )
    const html = inspectChatGptPage(10000).answer!.html
    expect(html).not.toContain("<svg")
    expect(html).not.toContain("javascript:")
  })

  test("removes executable markup and normalizes relative citations", () => {
    conversation(
      '<p onclick="alert(1)">Answer<script>alert(1)</script><iframe src="/bad"></iframe><a href="javascript:alert(1)">bad</a><a href="/c/citation">source</a><img src="data:text/html,bad" onerror="alert(1)" srcset="bad"></p>',
    )
    const html = inspectChatGptPage(10000).answer!.html
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<iframe")
    expect(html).not.toContain("onclick")
    expect(html).not.toContain("onerror")
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("data:")
    expect(html).not.toContain("srcset")
    expect(html).toContain('href="https://chatgpt.com/c/citation"')
  })

  test("marks oversize output incomplete instead of silently returning success", () => {
    conversation("<p>Long answer with more text</p>")
    const result = inspectChatGptPage(10)
    expect(result.answer?.truncated).toBe(true)
    expect(result.answer?.complete).toBe(false)
    expect(result.answer?.html.length).toBeLessThanOrEqual(10)
  })

  test("tracks DOM changes and reuses synthetic ids within one document", async () => {
    conversation("<p>Partial</p>", false)
    document.querySelector('[data-message-id="a1"]')!.removeAttribute("data-message-id")
    const first = inspectChatGptPage(10000)
    document.querySelector(".markdown")!.textContent = "Updated"
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = inspectChatGptPage(10000)
    expect(second.revision).toBeGreaterThan(first.revision)
    expect(second.answer?.id).toBe(first.answer?.id)
  })
})
