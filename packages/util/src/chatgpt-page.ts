import { GPT_PRO_MAX_HTML_CHARS, type GptProPageState } from "./gpt-pro"

// Passive, best-effort label observation. Never open menus or infer a model
// from available options, reasoning effort, slider position, or cached rows.
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
  return { trigger }
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

export function chatGptComposerAttachmentTarget() {
  const editorSelector = '#prompt-textarea, [data-composer-markdown][role="textbox"][contenteditable="true"]'
  const inputSelector = 'input[type="file"][aria-label="Attach files"]'
  const hiddenByStyle = (el: Element) => {
    for (let current: Element | null = el; current; current = current.parentElement) {
      const style = getComputedStyle(current)
      const inline = (current.getAttribute("style") ?? "").toLowerCase().replace(/\s/g, "")
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.contentVisibility === "hidden" ||
        /(?:^|;)display:none(?:;|$)/.test(inline) ||
        /(?:^|;)visibility:hidden(?:;|$)/.test(inline) ||
        /(?:^|;)content-visibility:hidden(?:;|$)/.test(inline)
      )
        return true
    }
    return false
  }
  const visible = (el: Element) =>
    el.getClientRects().length > 0 && !hiddenByStyle(el) && !el.closest('[inert], [hidden], [aria-hidden="true"]')
  const eligible = (input: HTMLInputElement) =>
    input.type === "file" &&
    !input.disabled &&
    input.getAttribute("aria-disabled") !== "true" &&
    !input.parentElement?.closest('[inert], [hidden], [aria-hidden="true"]')
  const editors = [...document.querySelectorAll<HTMLElement>(editorSelector)].filter(visible)
  const globalInputs = [...document.querySelectorAll<HTMLInputElement>(inputSelector)]
  const result = {
    editor: null as HTMLElement | null,
    input: null as HTMLInputElement | null,
    editorCount: editors.length,
    globalInputCount: globalInputs.length,
    eligibleGlobalInputCount: globalInputs.filter(eligible).length,
    scopedInputCount: 0,
    reason: "ok" as "ok" | "no-editor" | "ambiguous-editor" | "no-scoped-input" | "ambiguous-scoped-input",
  }
  if (!editors.length) {
    result.reason = "no-editor"
    return result
  }
  if (editors.length !== 1) {
    result.reason = "ambiguous-editor"
    return result
  }
  result.editor = editors[0]
  let wrapper: HTMLElement | null = editors[0].parentElement
  while (wrapper && wrapper !== document.body) {
    const scoped = [...wrapper.querySelectorAll<HTMLInputElement>(inputSelector)].filter(eligible)
    if (scoped.length) {
      result.scopedInputCount = scoped.length
      if (scoped.length !== 1) {
        result.reason = "ambiguous-scoped-input"
        return result
      }
      result.input = scoped[0]
      return result
    }
    wrapper = wrapper.parentElement
  }
  result.reason = "no-scoped-input"
  return result
}

export const CHATGPT_COMPOSER_ATTACHMENT_TARGET_EXPRESSION =
  `(${chatGptComposerAttachmentTarget.toString()})()`

export function chatGptSendTarget(attachmentTarget = chatGptComposerAttachmentTarget()) {
  type Reason = NonNullable<GptProPageState["sendControlDiagnostics"]>["reason"]
  const result = {
    editor: attachmentTarget.editor,
    send: null as HTMLButtonElement | null,
    reason: "ok" as Reason,
    editorCount: attachmentTarget.editorCount,
    scopedControlCount: 0,
  }
  if (!attachmentTarget.editor) {
    result.reason = attachmentTarget.reason === "ambiguous-editor" ? "ambiguous-editor" : "no-editor"
    return result
  }

  const visible = (el: Element) => {
    if (el.getClientRects().length === 0 || el.closest('[inert], [hidden], [aria-hidden="true"]')) return false
    for (let current: Element | null = el; current; current = current.parentElement) {
      const style = getComputedStyle(current)
      if (style.display === "none" || style.visibility === "hidden" || style.contentVisibility === "hidden")
        return false
    }
    return true
  }
  const selector =
    'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"], button[aria-label="发送消息"], button[aria-label="发送提示"]'
  const usable = (button: HTMLButtonElement) =>
    visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true"
  const resolve = (scope: Element) => [...scope.querySelectorAll<HTMLButtonElement>(selector)].filter(visible)
  let scope: HTMLElement | null = attachmentTarget.editor.parentElement
  while (scope && scope !== document.body) {
    const controls = resolve(scope)
    if (controls.length) {
      result.scopedControlCount = controls.length
      if (controls.length !== 1) {
        result.reason = "ambiguous-scoped-control"
        return result
      }
      const button = controls[0]!
      if (!usable(button)) {
        result.reason = "disabled-control"
        return result
      }
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      if (!hit || (hit !== button && !button.contains(hit))) {
        result.reason = "obscured-control"
        return result
      }
      result.send = button
      return result
    }
    scope = scope.parentElement
  }

  // Minimal DOM fixtures may put the sole editor and send control directly on body.
  if (attachmentTarget.editor.parentElement === document.body) {
    const controls = resolve(document.body)
    result.scopedControlCount = controls.length
    if (controls.length > 1) {
      result.reason = "ambiguous-scoped-control"
      return result
    }
    if (controls.length === 1) {
      const button = controls[0]!
      if (!usable(button)) {
        result.reason = "disabled-control"
        return result
      }
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      if (!hit || (hit !== button && !button.contains(hit))) {
        result.reason = "obscured-control"
        return result
      }
      result.send = button
      return result
    }
  }
  result.reason = "no-scoped-control"
  return result
}

export const CHATGPT_SEND_TARGET_EXPRESSION =
  `(${chatGptSendTarget.toString()})((${chatGptComposerAttachmentTarget.toString()})()).send`

// Serialized into the page: all browser helpers must remain inside this function.
// It reads only rendered conversation data, never credentials or private APIs.
export function inspectChatGptPage(
  maxChars: number,
  picker = chatGptModelPicker(),
  readComposer = readChatGptComposer,
  attachmentTarget = chatGptComposerAttachmentTarget(),
  sendTarget = chatGptSendTarget(attachmentTarget),
): GptProPageState {
  const visible = (el: Element) =>
    el.getClientRects().length > 0 &&
    !el.closest('[inert], [hidden], [aria-hidden="true"]') &&
    (() => {
      for (let current: Element | null = el; current; current = current.parentElement) {
        const style = getComputedStyle(current)
        if (style.display === "none" || style.visibility === "hidden" || style.contentVisibility === "hidden")
          return false
      }
      return true
    })()
  const normalize = (value: string) => value.replace(/\r\n/g, "\n").trim()
  const readText = (el: Element) => normalize((el as HTMLElement).innerText || el.textContent || "")
  const modelButton = picker.trigger
  const modelLabel = modelButton ? readText(modelButton) : ""
  const model = modelLabel
  const composer = attachmentTarget.editor
  const attachmentCards = composer
    ?.closest("[data-composer-body]")
    ?.querySelector("[data-composer-attachments][data-visible-attachments]")
  const attachmentNames = (container: Element | null | undefined) => {
    if (!container) return []
    const cards = [...container.querySelectorAll<HTMLElement>('[class~="group/composer-attachment"]')]
    const wrapper = container.querySelector(":scope > div.flex-wrap")
    const unknownChild =
      wrapper && [...wrapper.children].some((child) => !child.classList.contains("group/composer-attachment"))
    const attachments = cards.map((card) => {
      const name =
        card.querySelector<HTMLElement>("span.truncate")?.innerText?.trim() ||
        card.getAttribute("aria-label")?.trim() ||
        ""
      const uploading = [...card.querySelectorAll('[role="progressbar"]')].some(visible)
      const failed = [...card.querySelectorAll('[role="alert"], [data-upload-error]')].some(visible)
      const preview = [...card.querySelectorAll<HTMLButtonElement>('button[type="button"]')].some(
        (button) =>
          visible(button) &&
          button.getAttribute("aria-label") === name &&
          button.getAttribute("aria-busy") !== "true" &&
          !button.disabled,
      )
      const remove = [...card.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) =>
          visible(button) &&
          button.getAttribute("aria-label") === `Remove ${name}` &&
          !button.disabled &&
          button.getAttribute("aria-disabled") !== "true",
      )
      return {
        name,
        status: failed
          ? ("failed" as const)
          : uploading
            ? ("uploading" as const)
            : preview && remove
              ? ("ready" as const)
              : ("unknown" as const),
      }
    })
    if (unknownChild || (!cards.length && wrapper?.children.length))
      attachments.push({ name: "", status: "unknown" as const })
    return attachments
  }
  let generating = [
    ...document.querySelectorAll(
      '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"]',
    ),
  ].some(visible)
  type Tracking = {
    documentID: string
    nextID: number
    revision: number
    observer: MutationObserver
    ids: WeakMap<Element, string>
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
    record.stop = () => {
      record.observer.disconnect()
    }
    tracking = record
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
        'button, [role="button"], [data-composer-attachments], [data-visible-attachments], [class~="group/composer-attachment"], [class~="composer-attachment-surface"], [class~="group/resource-card"], [data-markdown-copy="exclude"], [data-thread-find-skip], [aria-hidden="true"]',
      )
      .forEach((node) => node.remove())
    return normalize(readComposer(clone))
  }
  const userAttachments = (turn: HTMLElement) => {
    const documents = [...turn.querySelectorAll<HTMLElement>('[class~="group/resource-card"]')]
      .map((card) => {
        const label = card.querySelector<HTMLElement>("span.truncate[title]")
        const name = label?.getAttribute("title")?.trim() ?? ""
        const ready = [...card.querySelectorAll<HTMLButtonElement>('button[type="button"]')].some(
          (button) =>
            visible(button) &&
            button.getAttribute("aria-label") === name &&
            button.getAttribute("aria-busy") === "false" &&
            !button.disabled,
        )
        const uploading = [...card.querySelectorAll<HTMLButtonElement>('button[type="button"]')].some(
          (button) =>
            visible(button) &&
            button.getAttribute("aria-label") === name &&
            button.getAttribute("aria-busy") === "true",
        )
        return {
          name,
          kind: "document" as const,
          status: ready ? ("ready" as const) : uploading ? ("uploading" as const) : ("unknown" as const),
        }
      })
      .filter((attachment) => attachment.name)
    return documents
  }
  const lastUser = users.at(-1)
  const lastUserIndex = lastUser ? turns.indexOf(lastUser) : -1
  const assistantForUser = (userIndex: number) => {
    const nextUser = turns.findIndex((turn, index) => index > userIndex && role(turn) === "user")
    const end = nextUser < 0 ? turns.length : nextUser
    return turns.slice(userIndex + 1, end).filter((turn) => role(turn) === "assistant").at(-1)
  }
  const assistantTurn = (assistant: HTMLElement) =>
    assistant.closest<HTMLElement>('article, [data-testid^="conversation-turn-"], .group.flex.flex-col') ?? assistant
  const stopSelector = '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"]'
  const answerFor = (user: HTMLElement, assistant: HTMLElement, isLatest: boolean) => {
    const contents = assistant.querySelectorAll<HTMLElement>('.markdown, [data-markdown-text-style="assistant-message"]')
    // Multiple regions can include reasoning and a final answer. Never guess which one is the answer.
    if (contents.length !== 1) return
    const content = contents[0]!
    const turn = assistantTurn(assistant)
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
            if (!["http:", "https:"].includes(target.protocol)) el.removeAttribute(name)
            else el.setAttribute(name, target.href)
          } catch {
            el.removeAttribute(name)
          }
        }
      }
    }
    const html = clone.innerHTML
    const text = readText(content)
    const truncated = html.length > maxChars || text.length > maxChars
    const responseActions = [...turn.querySelectorAll<HTMLButtonElement>("button")]
      .filter(
        (button) =>
          visible(button) &&
          !button.closest(
            '[data-user-message-bubble], .markdown, [data-markdown-text-style], [data-testid*="code"], [data-code-copy], [data-copy-code]',
          ),
      )
      .filter((button) => {
        const testID = button.getAttribute("data-testid") ?? ""
        const label = button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""
        return (
          testID === "copy-turn-action-button" ||
          /(?:response|turn)[-_ ]?(?:action|feedback|vote)/i.test(testID) ||
          /^(?:Copy|Regenerate response|Good response|Bad response|Share)$/i.test(label)
        )
      })
    const actionGroup = responseActions.length >= 2
    const settledMarker = [assistant, turn].some(
      (el) =>
        el.getAttribute("aria-busy") === "false" ||
        el.getAttribute("data-is-streaming") === "false" ||
        el.getAttribute("data-streaming") === "false",
    )
    const activeMarker = [assistant, turn].some(
      (el) =>
        el.getAttribute("aria-busy") === "true" ||
        el.getAttribute("data-is-streaming") === "true" ||
        el.getAttribute("data-streaming") === "true",
    )
    const turnGenerating =
      activeMarker || [...turn.querySelectorAll<HTMLButtonElement>(stopSelector)].some(visible) || (isLatest && generating)
    const completionEvidence = settledMarker
      ? ("settled-marker" as const)
      : actionGroup
        ? ("response-actions" as const)
        : ("unknown" as const)
    return {
      id: id(assistant),
      userID: id(user),
      text: text.slice(0, maxChars),
      html: html.slice(0, maxChars),
      complete: !turnGenerating && !truncated && !!text && completionEvidence !== "unknown",
      truncated,
      generating: turnGenerating,
      completionEvidence,
    }
  }
  const answers = users.flatMap((user) => {
    const assistant = assistantForUser(turns.indexOf(user))
    if (!assistant) return []
    const value = answerFor(user, assistant, user === lastUser)
    return value ? [value] : []
  })
  const answer = lastUser ? answers.findLast((item) => item.userID === id(lastUser)) : undefined
  generating ||= answers.some((item) => item.generating)
  const challengePattern =
    /cloudflare[_ -]?challenge|cf[-_]chl|verification required|verify (?:you are|that you are) human|security check|checking your browser|browser verification/i
  let error: GptProPageState["error"]
  if (!composer && /^(?:Just a moment|Attention Required)/i.test(document.title)) {
    error = {
      kind: "verification",
      scope: "page",
      message:
        "ChatGPT requires browser verification. Open gpt-pro and complete the page check before consulting again.",
    }
  } else if (root) {
    const pageChallenge = [
      ...root.querySelectorAll<HTMLElement>(
        '#challenge-form, #cf-challenge-running, #cf-challenge-stage, form[action*="/challenge"], [data-testid="challenge-form"], [data-testid="cf-challenge"], iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"]',
      ),
    ].some(
      (element) =>
        visible(element) &&
        !element.closest(
          '[data-message-author-role], [data-chatgpt-search-unit-key], [data-user-message-bubble], .markdown, [data-markdown-text-style]',
        ),
    )
    if (pageChallenge) {
      error = {
        kind: "verification",
        scope: "page",
        message: "ChatGPT requires human browser verification. No retry was attempted.",
      }
    } else if (lastUserIndex >= 0) {
      const assistant = assistantForUser(lastUserIndex)
      const currentTurn = assistant && assistantTurn(assistant)
      const retry = currentTurn
        ? [...currentTurn.querySelectorAll<HTMLButtonElement>("button")]
            .filter(visible)
            .find(
              (button) =>
                /^(Retry|Try again|重试|再试一次|再試一次|再試)$/i.test(readText(button)) &&
                !button.closest("[data-user-message-bubble], .markdown, [data-markdown-text-style]"),
            )
        : undefined
      if (retry && currentTurn) {
        let requestFailure = false
        let verificationFailure = false
        let region: Element | null = retry.parentElement
        for (let depth = 0; region && currentTurn.contains(region) && depth < 4; depth++, region = region.parentElement) {
          const clone = region.cloneNode(true) as HTMLElement
          clone
            .querySelectorAll(
              '[data-user-message-bubble], [data-search-result-target], [data-message-author-role="user"], [data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"], .markdown, [data-markdown-text-style], [class~="group/resource-card"], button, [role="button"], [aria-hidden="true"]',
            )
            .forEach((node) => node.remove())
          const status = readText(clone)
          if (challengePattern.test(status)) {
            verificationFailure = true
            break
          }
          if (/Unknown error|Something went wrong|There was an error|未知错误|未知錯誤|出现错误|發生錯誤/i.test(status))
            requestFailure = true
        }
        if (verificationFailure)
          error = {
            kind: "verification",
            scope: "turn",
            userID: id(lastUser!),
            message: "ChatGPT requires human browser verification in the current conversation. No retry was attempted.",
          }
        else if (requestFailure)
          error = {
            kind: "request",
            scope: "turn",
            userID: id(lastUser!),
            message:
              "ChatGPT displayed a request error for the current turn. The question was not retried; check browser verification, login or network access.",
          }
      }
    }
  }
  return {
    url: location.href,
    model,
    targetModel: /^(?:Pro|GPT[\s-]*6[\s-]+Pro)$/i.test(model),
    composer: !!composer && visible(composer),
    draft: composer ? normalize(readComposer(composer)) : "",
    attachmentInput: attachmentTarget.reason === "ok" && attachmentTarget.input !== null,
    attachmentInputDiagnostics: {
      editorCount: attachmentTarget.editorCount,
      globalInputCount: attachmentTarget.globalInputCount,
      eligibleGlobalInputCount: attachmentTarget.eligibleGlobalInputCount,
      scopedInputCount: attachmentTarget.scopedInputCount,
      reason: attachmentTarget.reason,
    },
    attachments: attachmentNames(attachmentCards),
    generating,
    sendReady: !!sendTarget.send && !generating,
    sendControlDiagnostics: {
      reason: sendTarget.reason,
      editorCount: sendTarget.editorCount,
      scopedControlCount: sendTarget.scopedControlCount,
    },
    ...(error ? { error } : {}),
    revision: tracking.revision,
    users: users.map((el) => {
      const attachments = userAttachments(el)
      return {
        id: id(el),
        text: userText(el).slice(0, maxChars),
        ...(attachments.length ? { attachments } : {}),
      }
    }),
    ...(answer ? { answer, answers } : { answers }),
  }
}

export const CHATGPT_INSPECT_EXPRESSION = `(()=>{const attachmentTarget=(${chatGptComposerAttachmentTarget.toString()})();const sendTarget=(${chatGptSendTarget.toString()})(attachmentTarget);return (${inspectChatGptPage.toString()})(${GPT_PRO_MAX_HTML_CHARS},${CHATGPT_MODEL_PICKER_EXPRESSION},(${readChatGptComposer.toString()}),attachmentTarget,sendTarget)})()`

// Image previews are inspected separately so the main page snapshot stays
// synchronous and no image bytes ever leave the page context.
export async function inspectChatGptImageAttachments(attachmentTarget = chatGptComposerAttachmentTarget()) {
  type Evidence = {
    name: string
    kind: "image"
    sha256?: string
    status: "ready" | "unknown"
  }
  const visible = (el: Element) =>
    el.getClientRects().length > 0 &&
    !el.closest('[inert], [hidden], [aria-hidden="true"]') &&
    getComputedStyle(el).visibility !== "hidden"
  const cacheWindow = window as typeof window & {
    __opencodeGptProImageDigestCache?: WeakMap<HTMLImageElement, { src: string; digest: Promise<string | undefined> }>
  }
  const cache = (cacheWindow.__opencodeGptProImageDigestCache ??= new WeakMap())
  const digest = (img: HTMLImageElement) => {
    const src = img.currentSrc || img.getAttribute("src") || ""
    const previous = cache.get(img)
    if (previous?.src === src && img.isConnected) return previous.digest
    const value = (async () => {
      const limit = 20 * 1024 * 1024
      const isCurrent = () => img.isConnected && (img.currentSrc || img.getAttribute("src") || "") === src
      const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(src)
      try {
        let bytes: Uint8Array
        if (match) {
          if (match[1].length > Math.ceil(limit / 3) * 4) return undefined
          const binary = atob(match[1])
          if (binary.length > limit) return undefined
          bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
        } else {
          const url = new URL(src, location.href)
          if (url.protocol !== "blob:" || url.origin !== location.origin) return undefined
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 8000)
          try {
            const response = await fetch(url.href, {
              signal: controller.signal,
              credentials: "omit",
              mode: "same-origin",
              cache: "no-store",
              referrerPolicy: "no-referrer",
            })
            if (!response.ok || (response.url && response.url !== url.href)) return undefined
            const contentType = response.headers.get("content-type")
            if (contentType && !/^image\/(?:png|jpeg|webp)(?:;|$)/i.test(contentType)) return undefined
            const contentLength = Number(response.headers.get("content-length"))
            if (Number.isFinite(contentLength) && contentLength > limit) return undefined
            const reader = response.body?.getReader()
            if (!reader) return undefined
            const chunks: Uint8Array[] = []
            let total = 0
            while (true) {
              const result = await reader.read()
              if (result.done) break
              total += result.value.byteLength
              if (total > limit) {
                await reader.cancel().catch(() => {})
                return undefined
              }
              chunks.push(result.value)
            }
            if (!total) return undefined
            bytes = new Uint8Array(total)
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
          } finally {
            clearTimeout(timer)
          }
        }
        const digestInput = Uint8Array.from(bytes).buffer as ArrayBuffer
        const result = await crypto.subtle.digest("SHA-256", digestInput)
        if (!isCurrent()) return undefined
        return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
      } catch {
        return undefined
      }
    })()
    const cached = { src, digest: value }
    cache.set(img, cached)
    void value.then((result) => {
      if (!result && cache.get(img) === cached) cache.delete(img)
    })
    return value
  }
  const composer = attachmentTarget.editor
  const composerContainer = composer
    ?.closest("[data-composer-body]")
    ?.querySelector("[data-composer-attachments][data-visible-attachments]")
  const composerCards = [
    ...(composerContainer?.querySelectorAll<HTMLElement>('[class~="group/composer-attachment"]') ?? []),
  ]
  const composerImages = await Promise.all(
    composerCards.map(async (card): Promise<Evidence | undefined> => {
      const name =
        card.querySelector<HTMLElement>("span.truncate")?.innerText?.trim() ||
        card.getAttribute("aria-label")?.trim() ||
        ""
      const preview =
        card.getAttribute("role") === "button" &&
        card.getAttribute("aria-label") === name &&
        card.getAttribute("aria-haspopup") === "dialog" &&
        card.getAttribute("aria-expanded") === "false" &&
        card.getAttribute("aria-disabled") !== "true"
      if (!name || !preview) return
      const img = [...card.querySelectorAll<HTMLImageElement>("img")].find(
        (candidate) => visible(candidate) && candidate.complete && candidate.naturalWidth > 0,
      )
      if (!img) return
      const sha256 = await digest(img)
      const remove = [...card.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => visible(button) && button.getAttribute("aria-label") === `Remove ${name}` && !button.disabled,
      )
      const ready = !!sha256 && preview && remove
      return { name, kind: "image", ...(sha256 ? { sha256 } : {}), status: ready ? "ready" : "unknown" }
    }),
  )
  const root = [...document.querySelectorAll("main")].filter(visible).at(-1)
  const turns = root
    ? [...root.querySelectorAll<HTMLElement>("[data-message-author-role], [data-chatgpt-search-unit-key]")]
    : []
  const role = (el: HTMLElement) => el.dataset.messageAuthorRole ?? el.dataset.chatgptSearchUnitKey?.split(":").at(-1)
  const turnID = (el: HTMLElement) => {
    const messageIDs = [...new Set((el.dataset.chatgptSearchMessageIds ?? "").split(" ").filter(Boolean))]
    return el.dataset.messageId ?? (messageIDs.length === 1 ? messageIDs[0] : undefined)
  }
  const users = await Promise.all(
    turns
      .filter((turn) => role(turn) === "user")
      .map(async (turn) => ({
        id: turnID(turn),
        attachments: await Promise.all(
          [...turn.querySelectorAll<HTMLElement>('div[role="button"][aria-label="User attachment"]')].map(
            async (card): Promise<Evidence> => {
              const img = [...card.querySelectorAll<HTMLImageElement>('img[alt="User attachment"]')].find(
                (candidate) => visible(candidate) && candidate.complete && candidate.naturalWidth > 0,
              )
              const sha256 = img ? await digest(img) : undefined
              const ready =
                !!sha256 &&
                img?.getAttribute("aria-expanded") === "false" &&
                img.getAttribute("data-state") === "closed"
              return {
                name: "",
                kind: "image",
                ...(sha256 ? { sha256 } : {}),
                status: ready ? "ready" : "unknown",
              }
            },
          ),
        ),
      })),
  )
  return { url: location.href, composer: composerImages.filter((item): item is Evidence => !!item), users }
}

export const CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION = `(${inspectChatGptImageAttachments.toString()})((${chatGptComposerAttachmentTarget.toString()})())`
