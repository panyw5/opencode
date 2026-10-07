import { GPT_PRO_MAX_HTML_CHARS, type GptProPageState } from "./gpt-pro"

// Shared by inspection and automation; serialize this helper with its callers.
export function chatGptModelPicker() {
  const visible = (el: Element) =>
    el.getClientRects().length > 0 &&
    !el.closest('[inert], [hidden], [aria-hidden="true"]') &&
    getComputedStyle(el).visibility !== "hidden"
  const trigger = [
    ...document.querySelectorAll(
      '[data-testid="model-switcher-dropdown-button"], button[aria-label="Select ChatGPT model"]',
    ),
  ]
    .filter(visible)
    .at(-1)
  const menuID = trigger?.getAttribute("aria-controls")
  const associated = menuID ? document.getElementById(menuID) : null
  const menus = [...document.querySelectorAll('[role="menu"]')]
    .filter(visible)
    .filter((el) => el.querySelector("[data-model-picker-view-toggle]"))
  const menu =
    associated && visible(associated)
      ? associated
      : trigger?.getAttribute("aria-expanded") === "true" && menus.length === 1
        ? menus[0]
        : null
  // aria-hidden belongs to the view track, not the selected-model row.
  const rows = menu ? [...menu.querySelectorAll("[data-model-picker-view-toggle]")].filter(visible) : []
  return { trigger, menu, row: rows.length === 1 ? rows[0] : undefined }
}

export const CHATGPT_MODEL_PICKER_EXPRESSION = `(${chatGptModelPicker.toString()})()`

// Dismiss only promotional overlays, never login, consent, or destructive dialogs.
export function chatGptOnboardingDismissal() {
  const visible = (el: Element) =>
    el.getClientRects().length > 0 &&
    !el.closest('[inert], [hidden], [aria-hidden="true"]') &&
    getComputedStyle(el).visibility !== "hidden"
  document
    .querySelectorAll("[data-opencode-gpt-pro-dismiss]")
    .forEach((el) => el.removeAttribute("data-opencode-gpt-pro-dismiss"))
  for (const dialog of [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible)) {
    const heading = dialog.querySelector('h1,h2,h3,[role="heading"]')?.textContent?.trim() ?? ""
    if (!/what['\u2019]?s new|introducing|new feature|new in chatgpt|新功能|功能介绍|新增功能|新機能/i.test(heading))
      continue
    if (/log in|sign in|sign up|delete|permission|consent|登录|登入|删除|授权|同意/i.test(dialog.textContent ?? ""))
      continue
    const button = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .filter(visible)
      .find(
        (el) =>
          !el.disabled &&
          el.getAttribute("aria-disabled") !== "true" &&
          /^(?:close|dismiss|got it|okay|ok|not now|关闭|關閉|知道了|我知道了|暂不|稍后)$/i.test(
            el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "",
          ),
      )
    if (!button) continue
    button.setAttribute("data-opencode-gpt-pro-dismiss", "true")
    return { heading: heading.slice(0, 100), selector: '[data-opencode-gpt-pro-dismiss="true"]' }
  }
  return null
}

export const CHATGPT_ONBOARDING_DISMISS_EXPRESSION = `(${chatGptOnboardingDismissal.toString()})()`

// Input.insertText creates one ProseMirror paragraph per newline. innerText
// adds layout spacing between paragraphs, so it cannot verify multiline input.
export function readChatGptComposer(editor: HTMLElement) {
  if (editor instanceof HTMLTextAreaElement) return editor.value
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
    if (!(node instanceof Element)) return ""
    if (node.tagName === "BR") return node.classList.contains("ProseMirror-trailingBreak") ? "" : "\n"
    return [...node.childNodes].map(read).join("")
  }
  const children = [...editor.childNodes]
  if (children.some((node) => node instanceof Element && /^(P|DIV)$/.test(node.tagName)))
    return children.map(read).join("\n")
  return read(editor)
}

// Serialized into the page: all browser helpers must remain inside this function.
// It reads only rendered conversation data, never credentials or private APIs.
export function inspectChatGptPage(
  maxChars: number,
  picker = chatGptModelPicker(),
  readComposer = readChatGptComposer,
): GptProPageState {
  const visible = (el: Element) =>
    el.getClientRects().length > 0 &&
    !el.closest('[inert], [hidden], [aria-hidden="true"]') &&
    getComputedStyle(el).visibility !== "hidden"
  const normalize = (value: string) => value.replace(/\r\n/g, "\n").trim()
  const readText = (el: Element) => normalize((el as HTMLElement).innerText || el.textContent || "")
  const modelButton = picker.trigger
  const modelLabel = modelButton ? readText(modelButton) : ""
  let model = modelLabel
  const composer = [
    ...document.querySelectorAll<HTMLElement>(
      '#prompt-textarea, [data-composer-markdown][role="textbox"][contenteditable="true"]',
    ),
  ].find(visible)
  const generating = [
    ...document.querySelectorAll(
      '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"]',
    ),
  ].some(visible)
  const sendControls = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"], button[aria-label="发送消息"], button[aria-label="发送提示"]',
    ),
  ].filter((el) => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true")

  type Tracking = {
    documentID: string
    nextID: number
    revision: number
    observer: MutationObserver
    ids: WeakMap<Element, string>
    modelEvidence?: { trigger: Element; effort: string | null }
    stop: () => void
  }
  const trackingWindow = window as typeof window & { __opencodeGptProTracking?: Tracking }
  let tracking = trackingWindow.__opencodeGptProTracking
  if (!tracking) {
    const record: Tracking = {
      documentID: crypto.randomUUID(),
      nextID: 0,
      revision: 0,
      ids: new WeakMap(),
      observer: new MutationObserver(() => record.revision++),
      stop: () => {},
    }
    record.observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-message-id", "data-message-author-role", "disabled"],
    })
    trackingWindow.__opencodeGptProTracking = record
    const invalidate = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") return
      const target = event.target
      if (
        event.isTrusted &&
        target instanceof Element &&
        target.closest('button[aria-label="Select ChatGPT model"], [role="menu"]')
      )
        record.modelEvidence = undefined
    }
    document.addEventListener("pointerdown", invalidate, true)
    document.addEventListener("keydown", invalidate, true)
    record.stop = () => {
      record.observer.disconnect()
      document.removeEventListener("pointerdown", invalidate, true)
      document.removeEventListener("keydown", invalidate, true)
    }
    tracking = record
  }
  // The current Chat UI labels the closed trigger only "Pro". Require an
  // observed associated picker row "6 / Pro", not that bare trigger label.
  const { menu, row } = picker
  const effort = modelButton?.getAttribute("data-selected-reasoning-effort") ?? null
  if (modelButton && row && visible(menu!) && visible(row) && /^(?:GPT[\s-]*)?6\s*Pro$/i.test(readText(row))) {
    tracking.modelEvidence = { trigger: modelButton, effort }
    model = "GPT-6 Pro"
  } else if (
    modelButton &&
    tracking.modelEvidence?.trigger === modelButton &&
    tracking.modelEvidence.effort === effort &&
    /\bPro\b/i.test(modelLabel)
  ) {
    model = "GPT-6 Pro"
  } else if (!/\bGPT[\s-]*6[\s-]+Pro\b/i.test(modelLabel)) {
    tracking.modelEvidence = undefined
  }
  const id = (el: HTMLElement) => {
    const messageIDs = [...new Set((el.dataset.chatgptSearchMessageIds ?? "").split(" ").filter(Boolean))]
    const messageID = el.dataset.messageId ?? (messageIDs.length === 1 ? messageIDs[0] : undefined)
    if (messageID) return messageID
    const previous = tracking.ids.get(el)
    if (previous) return previous
    const next = `${tracking.documentID}:${++tracking.nextID}`
    tracking.ids.set(el, next)
    return next
  }

  const root = [...document.querySelectorAll("main")].filter(visible).at(-1)
  const turns = root
    ? [...root.querySelectorAll<HTMLElement>("[data-message-author-role], [data-chatgpt-search-unit-key]")]
    : []
  const role = (el: HTMLElement) => el.dataset.messageAuthorRole ?? el.dataset.chatgptSearchUnitKey?.split(":").at(-1)
  const users = turns.filter((el) => role(el) === "user")
  const userText = (el: HTMLElement) => {
    const bubble = el.querySelector<HTMLElement>("[data-user-message-bubble]") ?? el
    // Long messages remain in the DOM behind a height clamp; the surrounding
    // ellipsis and Show more/less controls are not part of the submitted prompt.
    const content = bubble.querySelector<HTMLElement>("[data-search-result-target]")
    if (content) return normalize(readComposer(content))
    const clone = bubble.cloneNode(true) as HTMLElement
    clone
      .querySelectorAll(
        'button, [role="button"], [data-markdown-copy="exclude"], [data-thread-find-skip], [aria-hidden="true"]',
      )
      .forEach((node) => node.remove())
    return normalize(readComposer(clone))
  }
  const lastUser = users.at(-1)
  const lastUserIndex = lastUser ? turns.indexOf(lastUser) : -1
  const replies = lastUserIndex < 0 ? [] : turns.slice(lastUserIndex + 1).filter((el) => role(el) === "assistant")
  const assistant = replies.at(-1)
  const contents = assistant?.querySelectorAll<HTMLElement>('.markdown, [data-markdown-text-style="assistant-message"]')
  // Multiple regions can include reasoning and a final answer. Until the
  // live adapter proves how to distinguish them, refuse an ambiguous reply.
  const content = contents?.length === 1 ? contents[0] : undefined
  const turn = assistant?.closest('article, [data-testid^="conversation-turn-"], .group.flex.flex-col')
  const copy = turn?.querySelector('[data-testid="copy-turn-action-button"], button[aria-label="Regenerate response"]')
  let error: GptProPageState["error"]
  if (!composer && /^(?:Just a moment|Attention Required)/i.test(document.title)) {
    error = {
      kind: "verification",
      message:
        "ChatGPT requires browser verification. Open gpt-pro and complete the page check before consulting again.",
    }
  } else if (root) {
    const retry = [...root.querySelectorAll("button")].filter(visible).find(
      (el) =>
        /^(Retry|Try again|重试|再试一次|再試一次|再試)$/i.test(readText(el)) &&
        !el.closest("[data-user-message-bubble], .markdown, [data-markdown-text-style]") &&
        (() => {
          let region = el.parentElement
          for (let i = 0; region && region !== root && i < 3; i++, region = region.parentElement) {
            if (lastUser && region.contains(lastUser)) continue
            if (
              /Unknown error|Something went wrong|There was an error|未知错误|未知錯誤|出现错误|發生錯誤/i.test(
                readText(region),
              )
            )
              return true
          }
          return false
        })(),
    )
    if (retry)
      error = {
        kind: "request",
        message:
          "ChatGPT displayed a request error. The question was not retried; check browser verification, login or network access.",
      }
  }
  let answer: GptProPageState["answer"]
  if (content && assistant && lastUser) {
    const clone = content.cloneNode(true) as HTMLElement
    clone
      .querySelectorAll(
        "script, style, iframe, object, embed, form, input, button, meta, link, svg, animate, animateMotion, animateTransform, set, foreignObject, annotation-xml",
      )
      .forEach((el) => el.remove())
    for (const el of [clone, ...clone.querySelectorAll("*")]) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase()
        if (name.startsWith("on") || ["srcdoc", "style", "srcset"].includes(name)) el.removeAttribute(attr.name)
        if (["href", "src", "xlink:href", "action", "formaction"].includes(name)) {
          try {
            const target = new URL(attr.value, location.href)
            if (!["http:", "https:"].includes(target.protocol)) el.removeAttribute(attr.name)
            else el.setAttribute(attr.name, target.href)
          } catch {
            el.removeAttribute(attr.name)
          }
        }
      }
    }
    const html = clone.innerHTML
    const text = readText(content)
    const truncated = html.length > maxChars || text.length > maxChars
    answer = {
      id: id(assistant),
      userID: id(lastUser),
      text: text.slice(0, maxChars),
      html: html.slice(0, maxChars),
      complete: !!copy && !generating && !truncated && !!text,
      truncated,
    }
  }
  return {
    url: location.href,
    model,
    targetModel: /\bGPT[\s-]*6[\s-]+Pro\b/i.test(model),
    composer: !!composer && visible(composer),
    draft: composer ? normalize(readComposer(composer)) : "",
    generating,
    sendReady: !!composer && !generating && sendControls.length === 1,
    ...(error ? { error } : {}),
    revision: tracking.revision,
    users: users.map((el) => ({
      id: id(el),
      text: userText(el).slice(0, maxChars),
    })),
    ...(answer ? { answer } : {}),
  }
}

export const CHATGPT_INSPECT_EXPRESSION = `(${inspectChatGptPage.toString()})(${GPT_PRO_MAX_HTML_CHARS}, ${CHATGPT_MODEL_PICKER_EXPRESSION}, (${readChatGptComposer.toString()}))`
