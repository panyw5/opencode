import {
  CHATGPT_INSPECT_EXPRESSION,
  CHATGPT_COMPOSER_ATTACHMENT_TARGET_EXPRESSION,
  CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION,
  CHATGPT_ONBOARDING_DISMISS_EXPRESSION,
  CHATGPT_SEND_TARGET_EXPRESSION,
} from "@opencode-ai/util/chatgpt-page"
import { GPT_PRO_PARTITION, GPT_PRO_URL, isGptProOrigin, type GptProPageState } from "@opencode-ai/util/gpt-pro"
import type { BrowserController } from "./browser"
import type { BeforeTrustedClick } from "./browser-cdp"
import { GptProPageError } from "./gpt-pro-page-error"

const editorSelector = '#prompt-textarea, [data-composer-markdown][role="textbox"][contenteditable="true"]'
const attachmentInputSelector = 'input[type="file"][aria-label="Attach files"]'

export class GptProDriver {
  private observedCdp?: ReturnType<BrowserController["cdp"]>
  private stopObserving?: () => void
  constructor(
    private readonly browser: BrowserController,
    private readonly log: (message: string) => void = () => {},
  ) {}
  private cdp() {
    const cdp = this.browser.cdp(GPT_PRO_PARTITION)
    if (!cdp)
      throw new Error("The gpt-pro browser was closed. Reopen the consultation; no automatic resend is allowed.")
    return cdp
  }
  private blockingPageError(page: GptProPageState) {
    const error = page.error
    if (!error) return
    if (error.kind === "verification") return error
    if (error.kind === "request") {
      this.log(`driver passing request diagnostic scope=${error.scope ?? "legacy"} to consultation owner; no driver-wide gate`)
      return
    }
    return error
  }
  async open(url = GPT_PRO_URL, fresh = false) {
    this.log(`driver open fresh=${fresh}`)
    if (
      !isGptProOrigin(url) ||
      !/^\/(?:c\/(?:[a-zA-Z0-9-]+|local-chatgpt:[a-zA-Z0-9-]+))?$/.test(decodeURIComponent(new URL(url).pathname))
    )
      throw new Error("Invalid Chat conversation URL")
    const current = this.browser.getState().find((view) => view.partition === GPT_PRO_PARTITION)
    if (fresh && current && isGptProOrigin(current.url)) {
      const page = await this.page()
      if (page.draft.trim() || page.attachments?.length)
        throw new Error("A manual draft or attachment is present. It will not be erased to start a consultation.")
      if (page.generating)
        throw new Error(
          "A reply is being generated in the browser. It will not be interrupted to start another consultation.",
        )
      if (current.url === url && page.composer && !page.generating && !page.users.length) {
        this.browser.present(GPT_PRO_PARTITION)
        return
      }
    }
    if (fresh && current && isGptProOrigin(current.url)) {
      const routed = await this.cdp().evaluate<boolean>(`(() => {
        const el=[...document.querySelectorAll('button[aria-label="New chat"],a')].filter(e=>e.getClientRects().length&&!e.closest('[inert],[aria-hidden="true"]')).find(e=>e.getAttribute('aria-label')==='New chat'||e.textContent?.trim()==='New chat')
        if(!el) return false
        el.click(); return true
      })()`)
      if (routed) {
        for (let i = 0; i < 40; i++) {
          const page = await this.page()
          if (
            new URL(page.url).pathname === "/" &&
            page.composer &&
            !page.users.length &&
            !page.draft.trim() &&
            !page.attachments?.length
          ) {
            await this.show()
            return
          }
          await new Promise((r) => setTimeout(r, 125))
        }
        throw new Error("New Chat navigation was not confirmed. No question was sent.")
      }
    }
    await this.browser.open(GPT_PRO_PARTITION, url)
    if (fresh && current?.url === url) await this.cdp().navigate(url)
    this.browser.present(GPT_PRO_PARTITION)
  }
  async show(url = GPT_PRO_URL) {
    if (!this.browser.has(GPT_PRO_PARTITION)) {
      this.log("driver restoring the closed consultation view without resubmitting")
      await this.open(url)
      return
    }
    this.browser.present(GPT_PRO_PARTITION)
  }
  async page(): Promise<GptProPageState> {
    const state = this.browser.getState().find((v) => v.partition === GPT_PRO_PARTITION)
    if (!state) throw new Error("The gpt-pro browser view is unavailable. Reopen the dedicated browser view.")
    if (!isGptProOrigin(state.url))
      throw new Error("The gpt-pro browser is on an unexpected origin. Navigate it to ChatGPT before continuing.")
    const cdp = this.cdp()
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const page = await cdp.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
        const imageEvidence = await cdp.evaluate<{
          url: string
          composer: Array<{ name: string; kind: "image"; sha256?: string; status: "ready" | "unknown" }>
          users: Array<{
            id?: string
            attachments: Array<{ name: string; kind: "image"; sha256?: string; status: "ready" | "unknown" }>
          }>
        }>(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
        const consistent =
          imageEvidence.url === page.url &&
          imageEvidence.users.length === page.users.length &&
          imageEvidence.users.every((user, index) => user.id === page.users[index]?.id)
        if (!consistent) {
          this.log(`driver page snapshot mismatch attempt=${attempt}/3; attachment evidence discarded`)
          continue
        }
        const used = new Set<number>()
        page.attachments = (page.attachments ?? []).map((attachment) => {
          const match = imageEvidence.composer.findIndex(
            (image, index) => !used.has(index) && image.name === attachment.name,
          )
          if (match < 0) return attachment
          used.add(match)
          return { ...attachment, ...imageEvidence.composer[match] }
        })
        page.users = page.users.map((user, index) => {
          const images = imageEvidence.users[index]?.attachments ?? []
          return images.length ? { ...user, attachments: [...(user.attachments ?? []), ...images] } : user
        })
        if (attempt > 1) this.log(`driver page snapshot consistency restored attempt=${attempt}/3`)
        return page
      } catch {
        this.log(`driver page snapshot inspection unavailable attempt=${attempt}/3; retrying without dispatch`)
      }
    }
    this.log("driver page snapshot consistency unconfirmed; no page action may be dispatched")
    throw new Error("ChatGPT page snapshot could not be confirmed consistently. No page action was dispatched.")
  }
  async focus() {
    this.log("driver handing browser focus to the user; no input dispatched")
    await this.cdp().focus()
    const focused = await this.cdp().evaluate<boolean>(`(() => {
      const editor=[...document.querySelectorAll(${JSON.stringify(editorSelector)})].filter(e=>e.getClientRects().length&&!e.closest('[inert],[aria-hidden="true"]')).at(-1)
      if (!editor) return false
      editor.focus(); return document.activeElement===editor
    })()`)
    this.log(`driver handoff composerFocused=${!!focused}; page contents preserved`)
  }
  async dismissOnboarding() {
    for (let i = 0; i < 3; i++) {
      let overlay: { heading: string; selector: string } | null
      try {
        overlay = await this.cdp().evaluate<{ heading: string; selector: string } | null>(
          CHATGPT_ONBOARDING_DISMISS_EXPRESSION,
        )
      } catch {
        this.log(`driver promo dismissal inspection unavailable step=${i + 1}; continuing to control checks`)
        return
      }
      if (!overlay) return
      this.log(`driver best-effort promo dismissal step=${i + 1}`)
      try {
        await this.cdp().clickSelector(overlay.selector)
        await new Promise((resolve) => setTimeout(resolve, 125))
      } catch {
        this.log(`driver promo dismissal not dispatched step=${i + 1}; continuing to control checks`)
        return
      }
    }
    try {
      if (await this.cdp().evaluate(CHATGPT_ONBOARDING_DISMISS_EXPRESSION))
        this.log("driver promo remains after best-effort dismissal; editor focus and send hit tests decide readiness")
    } catch {
      this.log("driver promo state unavailable after best-effort dismissal; editor focus and send hit tests decide readiness")
    }
  }
  async ready() {
    this.log("driver waiting for rendered Chat composer")
    const cdp = this.cdp()
    if (this.observedCdp !== cdp) {
      this.stopObserving?.()
      this.observedCdp = cdp
      this.stopObserving = await cdp.onResponse((response) => {
        if (response.origin !== "https://chatgpt.com" || ![401, 403, 429].includes(response.status)) return
        if (
          !/^\/backend-api\/(?:me|(?:f\/)?conversation(?:\/init|\/prepare)?|sentinel\/chat-requirements\/prepare)$/.test(
            response.path,
          )
        )
          return
        this.log(
          `driver diagnostic response path=${response.path} status=${response.status}; no headers or body recorded; webpage state remains authoritative`,
        )
      })
    }
    let readiness = ""
    for (let i = 0; i < 360; i++) {
      try {
        const page = await this.page()
        const observed = `composer=${page.composer} model=${page.model || "pending"} error=${page.error?.kind ?? "none"}`
        if (observed !== readiness) {
          this.log(`driver readiness ${observed}`)
          readiness = observed
        }
        const blockingError = this.blockingPageError(page)
        if (blockingError?.kind === "verification" && i < 120) {
          if (i === 0) this.log("driver waiting for the website's automatic browser verification; no input dispatched")
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        if (blockingError) throw new GptProPageError(blockingError.message, blockingError.kind)
        await this.dismissOnboarding()
        if (page.composer) {
          this.log("driver composer ready")
          return page
        }
      } catch (error) {
        if (error instanceof GptProPageError) throw error
        /* navigation can replace the document */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error("The ChatGPT composer did not become available. The page may still be loading or its interface may have changed. No message was sent.")
  }
  async observeModel() {
    this.log("driver observing current model without opening or changing the picker")
    await this.dismissOnboarding()
    const page = await this.page()
    const blockingError = this.blockingPageError(page)
    if (blockingError) throw new GptProPageError(blockingError.message, blockingError.kind)
    this.log(
      `driver model observation label=${JSON.stringify(page.model || "unknown")} proLabel=${page.targetModel} policy=user-selected nonblocking=true`,
    )
    return page
  }
  async fill(prompt: string) {
    this.log(`driver filling composer promptChars=${prompt.length}`)
    const focused = await this.cdp().evaluate<boolean>(`(() => {
      const editor=[...document.querySelectorAll(${JSON.stringify(editorSelector)})].filter(e=>e.getClientRects().length&&!e.closest('[inert],[aria-hidden="true"]')).at(-1)
      if(!editor || (editor.innerText ?? editor.value ?? '').trim()) return false
      editor.focus(); return document.activeElement===editor
    })()`)
    if (!focused) throw new Error("The Chat composer contains a draft or cannot be focused. It was not overwritten.")
    await this.cdp().insertText(prompt)
    const expected = prompt.replace(/\r\n/g, "\n").trim()
    for (let i = 0; i < 20; i++) {
      const page = await this.page()
      const blockingError = this.blockingPageError(page)
      if (blockingError) throw new GptProPageError(blockingError.message, blockingError.kind)
      const actual = page.draft.replace(/\r\n/g, "\n").trim()
      if (actual === expected) {
        this.log(
          `driver composer verified expectedChars=${expected.length} actualChars=${actual.length} lines=${expected.split("\n").length}`,
        )
        return
      }
      if (i === 0 || i === 19) {
        let mismatch = 0
        while (mismatch < Math.min(expected.length, actual.length) && expected[mismatch] === actual[mismatch])
          mismatch++
        this.log(
          `driver composer mismatch attempt=${i + 1} expectedChars=${expected.length} actualChars=${actual.length} firstMismatch=${mismatch}; no prompt content recorded`,
        )
      }
      if (i < 19) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Chat composer verification failed. Submission was not attempted.")
  }
  async uploadAttachments(
    files: Array<{ path: string; name: string; mime?: string; sha256?: string }>,
    mayDispatch: boolean,
    shouldContinue?: () => Promise<boolean>,
    beforeDispatch?: () => Promise<void>,
  ) {
    if (!files.length) return
    const expected = files.map((file) => ({
      name: file.name,
      kind: file.mime?.startsWith("image/") ? ("image" as const) : ("document" as const),
    }))
    const expectedByName = new Map(expected.map((item) => [item.name, item.kind]))
    const expectedNames = new Set(files.map((file) => file.name))
    const matches = (page: GptProPageState) => {
      const current = page.attachments ?? []
      return (
        current.length === expected.length &&
        expected.every((item) => {
          const attachment = current.find((candidate) => candidate.name === item.name)
          if (!attachment || attachment.status !== "ready") return false
          if (item.kind === "document") return attachment.kind !== "image"
          return attachment.kind === "image" && /^[a-f0-9]{64}$/i.test(attachment.sha256 ?? "")
        })
      )
    }
    const incompatible = (cards: NonNullable<GptProPageState["attachments"]>) =>
      cards.length > files.length ||
      cards.some((attachment) => {
        if (attachment.name && !expectedNames.has(attachment.name)) return true
        if (!attachment.name) return attachment.status === "ready"
        const kind = expectedByName.get(attachment.name)
        if (!kind) return true
        if (attachment.kind && attachment.kind !== kind) return true
        if (attachment.status !== "ready") return false
        return kind === "image"
          ? attachment.kind !== "image" || !/^[a-f0-9]{64}$/i.test(attachment.sha256 ?? "")
          : attachment.kind === "image"
      })
    let page = await this.page()
    if (mayDispatch && page.attachments?.length)
      throw new Error("Composer attachments predate this consultation; no matching manual file was accepted")
    if (matches(page) && page.attachments?.every((attachment) => attachment.status === "ready")) {
      this.log(`driver attachments reconciled ready count=${files.length}; no duplicate upload dispatched`)
      return
    }
    if ((page.attachments?.length ?? 0) > 0) {
      const cards = page.attachments ?? []
      const transient = cards.some(
        (attachment) =>
          attachment.status === "uploading" ||
          (attachment.status === "unknown" && (!attachment.name || expectedNames.has(attachment.name))),
      )
      if (
        mayDispatch ||
        incompatible(cards) ||
        cards.some((attachment) => attachment.status === "failed") ||
        (!matches(page) && !transient)
      )
        throw new Error("Existing composer attachments are partial or ambiguous. No duplicate upload was attempted.")
      this.log(`driver waiting for existing attachment upload count=${files.length}`)
    } else {
      if (!mayDispatch)
        throw new Error("Attachment upload state is ambiguous after recovery; no duplicate upload was attempted")
      let readiness = ""
      for (let attempt = 0; attempt < 40 && !page.attachmentInput; attempt++) {
        if (shouldContinue && !(await shouldContinue())) throw new Error("Attachment workflow was cancelled")
        const blockingError = this.blockingPageError(page)
        if (blockingError) throw new GptProPageError(blockingError.message, blockingError.kind)
        const details = page.attachmentInputDiagnostics
        const state = `editors=${details?.editorCount ?? -1} globalInputs=${details?.globalInputCount ?? -1} eligibleGlobal=${details?.eligibleGlobalInputCount ?? -1} scoped=${details?.scopedInputCount ?? -1} reason=${details?.reason ?? "missing"}`
        if (state !== readiness) {
          this.log(`driver waiting for active composer file input attempt=${attempt + 1} ${state}`)
          readiness = state
        }
        if (page.attachments?.length)
          throw new Error("Composer attachments appeared before this consultation uploaded files; no matching manual file was accepted")
        await new Promise((resolve) => setTimeout(resolve, 250))
        page = await this.page()
        const nextBlockingError = this.blockingPageError(page)
        if (nextBlockingError) throw new GptProPageError(nextBlockingError.message, nextBlockingError.kind)
      }
      if (!page.attachmentInput) throw new Error("ChatGPT's verified attachment input is unavailable")
      this.log(`driver dispatching attachment upload count=${files.length}`)
      await this.cdp().setInputFiles(
        attachmentInputSelector,
        files.map((file) => file.path),
        CHATGPT_COMPOSER_ATTACHMENT_TARGET_EXPRESSION,
        beforeDispatch,
      )
    }
    let last = ""
    for (let attempt = 0; attempt < 240; attempt++) {
      if (shouldContinue && !(await shouldContinue())) throw new Error("Attachment workflow was cancelled")
      page = await this.page()
      const blockingError = this.blockingPageError(page)
      if (blockingError) throw new GptProPageError(blockingError.message, blockingError.kind)
      const cards = page.attachments ?? []
      const state = cards.map((item) => `${item.name || "unknown"}:${item.status}`).join(",") || "none"
      if (state !== last) {
        this.log(`driver attachment evidence attempt=${attempt + 1} count=${cards.length} cards=${state}`)
        last = state
      }
      if (matches(page) && cards.every((attachment) => attachment.status === "ready")) {
        this.log(`driver attachments verified ready count=${files.length}`)
        return
      }
      if (cards.some((attachment) => attachment.status === "failed"))
        throw new Error("ChatGPT reported an attachment upload error")
      if (incompatible(cards))
        throw new Error("Composer attachments do not match this consultation; no second upload was attempted")
      const transient = cards.some(
        (attachment) =>
          attachment.status === "uploading" ||
          (attachment.status === "unknown" && (!attachment.name || expectedNames.has(attachment.name))),
      )
      if (cards.length && !matches(page) && !transient)
        throw new Error("Composer attachments are incomplete. No question was submitted.")
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error("Attachment readiness was not confirmed. No question was submitted.")
  }
  async element(uid: string) {
    const cdp = this.cdp()
    const page = await this.page()
    return {
      composer: await cdp.matches(uid, editorSelector),
      send: Boolean(page.sendReady && (await cdp.matchesResolved(uid, CHATGPT_SEND_TARGET_EXPRESSION))),
      retry:
        (await cdp.matches(
          uid,
          '[data-testid*="retry" i],[data-testid*="regenerate" i],button[aria-label*="Retry" i],button[aria-label*="Regenerate" i]',
        )) || (await cdp.matchesText(uid, "^(?:retry|try again|regenerate(?: response)?)$")),
    }
  }
  recover() {
    this.log("driver recovery acknowledged; rendered webpage state remains authoritative")
  }
  async submit(beforeDispatch?: BeforeTrustedClick, uid?: string) {
    this.log("driver waiting for enabled Chat send control")
    let lastTargetState = ""
    for (let i = 0; i < 20; i++) {
      const page = await this.page()
      const blockingError = this.blockingPageError(page)
      if (blockingError) throw new GptProPageError(blockingError.message, blockingError.kind)
      const diagnostics = page.sendControlDiagnostics
      const targetState = `reason=${diagnostics?.reason ?? "missing"} editors=${diagnostics?.editorCount ?? -1} scopedControls=${diagnostics?.scopedControlCount ?? -1}`
      if (targetState !== lastTargetState) {
        this.log(`driver send target ${targetState}`)
        lastTargetState = targetState
      }
      if (page.sendReady) {
        this.log(
          `driver send model label=${JSON.stringify(page.model || "unknown")} policy=user-selected nonblocking=true`,
        )
        this.log("driver dispatching one trusted send-button click")
        if (uid) {
          if (!(await this.cdp().matchesResolved(uid, CHATGPT_SEND_TARGET_EXPRESSION)))
            throw new Error("Observed UID is not the exact current send target; no click dispatched")
          await this.cdp().click(uid, undefined, beforeDispatch)
        } else {
          await this.cdp().clickResolved(CHATGPT_SEND_TARGET_EXPRESSION, beforeDispatch)
        }
        this.log("driver send click dispatched; waiting for website acknowledgment")
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error("Chat send control did not become ready. No automatic resend was attempted.")
  }
  async stop() {
    this.log("driver checking generation before stop")
    if (!this.browser.has(GPT_PRO_PARTITION)) {
      this.log("driver stop: browser view already closed; no page action dispatched")
      return
    }
    const page = await this.page()
    if (!page.generating) return
    await this.cdp().clickSelector(
      '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"]',
    )
    if ((await this.page()).generating)
      await this.cdp().evaluate(`(() => {
      const el=[...document.querySelectorAll('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]')].filter(e=>e.getClientRects().length&&!e.closest('[inert],[aria-hidden="true"]')).at(-1)
      if(!el) throw new Error('Stop control is unavailable')
      el.click();return true
    })()`)
    for (let i = 0; i < 120; i++) {
      if (!(await this.page()).generating) {
        this.log("driver confirmed generation stopped")
        return
      }
      await new Promise((r) => setTimeout(r, 125))
    }
    throw new Error("Could not confirm that Chat generation stopped. The browser remains reserved.")
  }
}
