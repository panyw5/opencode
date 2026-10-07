import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  inspectChatGptPage,
  CHATGPT_INSPECT_EXPRESSION,
  CHATGPT_ONBOARDING_DISMISS_EXPRESSION,
} from "@opencode-ai/util/chatgpt-page"

const originalRects = Element.prototype.getClientRects
let originalUrl = ""

beforeEach(() => {
  originalUrl = window.location.href
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
  Element.prototype.getClientRects = originalRects
  document.body.innerHTML = ""
  ;(window as any).happyDOM.setURL(originalUrl)
})

function conversation(html: string, complete = true) {
  document.querySelector("main")!.innerHTML =
    `<article><div data-message-author-role="user" data-message-id="u1">Question</div></article><article><div data-message-author-role="assistant" data-message-id="a1"><div class="markdown">${html}</div></div>${complete ? '<button data-testid="copy-turn-action-button">Copy</button>' : ""}</article>`
}

describe("ChatGPT reply HTML extraction", () => {
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
