import {
  CHATGPT_INSPECT_EXPRESSION,
  CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION,
  CHATGPT_MODEL_PICKER_EXPRESSION,
  CHATGPT_ONBOARDING_DISMISS_EXPRESSION,
} from "@opencode-ai/util/chatgpt-page"
import { GPT_PRO_PARTITION, GPT_PRO_URL, isGptProOrigin, type GptProPageState } from "@opencode-ai/util/gpt-pro"
import type { BrowserController } from "./browser"
import { GptProPageError } from "./gpt-pro-page-error"

const sendSelector =
  '[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Send"],button[aria-label="发送消息"],button[aria-label="发送提示"]'

const editorSelector = '#prompt-textarea, [data-composer-markdown][role="textbox"][contenteditable="true"]'
const attachmentInputSelector = 'input[type="file"][aria-label="Attach files"]'
const triggerExpression = `${CHATGPT_MODEL_PICKER_EXPRESSION}.trigger`

export class GptProDriver {
  private observedCdp?: ReturnType<BrowserController["cdp"]>
  private stopObserving?: () => void
  private rejected?: { path: string; status: number; at: number }
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
  async open(url = GPT_PRO_URL, fresh = false) {
    this.log(`driver open fresh=${fresh}`)
    this.rejected = undefined
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
    if (!state || !isGptProOrigin(state.url)) throw new Error("Login to ChatGPT in the gpt-pro browser first.")
    const cdp = this.cdp()
    const page = await cdp.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
    const imageEvidence = await cdp.evaluate<{
      url: string
      composer: Array<{ name: string; kind: "image"; sha256?: string; status: "ready" | "unknown" }>
      users: Array<{
        id?: string
        attachments: Array<{ name: string; kind: "image"; sha256?: string; status: "ready" | "unknown" }>
      }>
    }>(CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
    const hasImageEvidence = imageEvidence.composer.length > 0 || imageEvidence.users.some((user) => user.attachments.length > 0)
    if (
      hasImageEvidence &&
      (imageEvidence.url !== page.url || imageEvidence.users.length !== page.users.length ||
        imageEvidence.users.some((user, index) => user.id !== page.users[index]?.id))
    )
      throw new Error("ChatGPT page changed during image attachment inspection; evidence was discarded")
    const used = new Set<number>()
    page.attachments = (page.attachments ?? []).map((attachment) => {
      const match = imageEvidence.composer.findIndex((image, index) => !used.has(index) && image.name === attachment.name)
      if (match < 0) return attachment
      used.add(match)
      return { ...attachment, ...imageEvidence.composer[match] }
    })
    page.users = page.users.map((user, index) => {
      const images = imageEvidence.users[index]?.attachments ?? []
      return images.length ? { ...user, attachments: [...(user.attachments ?? []), ...images] } : user
    })
    if (this.rejected && /\/(?:prepare|init)$/.test(this.rejected.path)) {
      if (page.users.length && (page.generating || page.answer)) {
        this.log(
          `driver preparation rejection superseded by rendered question/reply path=${this.rejected.path} status=${this.rejected.status}; no question resent`,
        )
        this.rejected = undefined
      } else if (Date.now() - this.rejected.at < 5000) {
        this.log(`driver waiting for website preparation recovery status=${this.rejected.status}; no input dispatched`)
        return page
      }
    }
    if (this.rejected && !page.error)
      page.error = {
        kind: "request",
        message: `ChatGPT rejected the browser request (HTTP ${this.rejected.status}). Check browser verification, login or network access. No automatic retry was performed.`,
      }
    return page
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
      const overlay = await this.cdp().evaluate<{ heading: string; selector: string } | null>(
        CHATGPT_ONBOARDING_DISMISS_EXPRESSION,
      )
      if (!overlay) return
      this.log(`driver dismissing promotional overlay heading=${overlay.heading} step=${i + 1}`)
      await this.cdp().clickSelector(overlay.selector)
      await new Promise((resolve) => setTimeout(resolve, 125))
    }
    if (await this.cdp().evaluate(CHATGPT_ONBOARDING_DISMISS_EXPRESSION))
      throw new GptProPageError("A feature overlay could not be dismissed. No question was sent.")
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
        this.rejected = { path: response.path, status: response.status, at: Date.now() }
        this.log(`driver request rejected path=${response.path} status=${response.status}; no headers or body recorded`)
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
        if (page.error?.kind === "verification" && i < 120) {
          if (i === 0) this.log("driver waiting for the website's automatic browser verification; no input dispatched")
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        if (page.error) throw new GptProPageError(page.error.message, page.error.kind)
        await this.dismissOnboarding()
        if (page.composer && page.model) {
          this.log("driver composer ready")
          return page
        }
      } catch (error) {
        if (error instanceof GptProPageError) throw error
        /* navigation can replace the document */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error("Chat page is not ready. Complete login or verification in the dedicated browser.")
  }
  async verify() {
    this.log("driver verifying visible model-picker evidence")
    await this.dismissOnboarding()
    const previous = await this.page()
    if (previous.error) throw new GptProPageError(previous.error.message, previous.error.kind)
    this.log(`driver initial model=${previous.model} verified=${previous.targetModel}`)
    if (previous.targetModel) return previous
    const cdp = this.cdp()
    try {
      this.log("driver opening associated model picker")
      await cdp.evaluate(`(async () => {
        for (let i=0; i<40; i++) {
          const picker = ${CHATGPT_MODEL_PICKER_EXPRESSION}
          if (picker.row) return true
          if(picker.trigger && picker.trigger.getAttribute('aria-expanded')!=='true') picker.trigger.click()
          await new Promise(r=>setTimeout(r,125))
        }
        throw new Error('Cannot read the visible Chat model row')
      })()`)
      let page = await this.page()
      this.log(`driver picker model=${page.model} verified=${page.targetModel}`)
      if (page.error) throw new GptProPageError(page.error.message, page.error.kind)
      if (!page.targetModel) {
        // Non-Pro Power rows may omit the version entirely (e.g. "High").
        // Adjust only this slider, then require explicit 6 Pro evidence before sending.
        const steps = await cdp.evaluate<number>(`(() => {
          const { menu, row } = ${CHATGPT_MODEL_PICKER_EXPRESSION}
          if (!row || !/^(?:(?:GPT[\\s-]*)?6\\s+)?(?:Instant|Light|Standard|Medium|High|Extended|Heavy|Pro)$/i.test(row.innerText.trim())) return 0
          const control = menu.querySelector('[data-reasoning-slider]')
          const slider = control?.querySelector('[role="slider"]')
          if (!control || control.closest('[inert],[hidden],[aria-hidden="true"]') || !control.getClientRects().length || !slider) return 0
          const max = Number(slider.getAttribute('aria-valuemax'))
          const now = Number(slider.getAttribute('aria-valuenow'))
          if (!Number.isInteger(max) || !Number.isInteger(now) || now < 0 || max <= now || max > 10) return 0
          control.focus()
          return document.activeElement === control ? max - now : 0
        })()`)
        this.log(`driver selecting Pro power steps=${steps}`)
        for (let i = 0; i < steps; i++) await cdp.pressArrowRight()
        for (let i = 0; steps > 0 && !page.targetModel && i < 20; i++) {
          await new Promise((r) => setTimeout(r, 125))
          page = await this.page()
          if (page.error) throw new GptProPageError(page.error.message, page.error.kind)
        }
        this.log(`driver selected model=${page.model} verified=${page.targetModel}`)
      }
      if (!page.targetModel)
        throw new Error(
          "Could not select and verify GPT-6 Pro in the Chat model picker. No API, Codex, Work, or fallback model will be used.",
        )
    } finally {
      try {
        const opened = await cdp.evaluate<boolean>(
          `(() => {const trigger=${triggerExpression}; return trigger?.getAttribute('aria-expanded')==='true' })()`,
        )
        if (opened) {
          this.log("driver closing model picker without sending")
          await cdp.pressEscape()
        }
      } catch (error) {
        this.log(`driver model picker cleanup failed error=${String(error)}`)
      }
    }
    const verified = await this.page()
    this.log(`driver final model=${verified.model} verified=${verified.targetModel}`)
    if (verified.error) throw new GptProPageError(verified.error.message, verified.error.kind)
    if (!verified.targetModel) throw new Error("Model evidence changed after closing the picker. Nothing was sent.")
    return verified
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
      if (page.error) throw new GptProPageError(page.error.message, page.error.kind)
      if (!page.targetModel) throw new Error("Model evidence changed before submission. Nothing was sent.")
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
  ) {
    if (!files.length) return
    const key = (attachment: { name: string; kind?: "document" | "image"; sha256?: string }) =>
      attachment.kind === "image" ? `image:${attachment.sha256 ?? "unknown"}` : `document:${attachment.name}`
    const expected = files
      .map((file) => (file.mime?.startsWith("image/") ? `image:${file.sha256 ?? "unknown"}` : `document:${file.name}`))
      .sort()
    const expectedNames = new Set(files.map((file) => file.name))
    const matches = (page: GptProPageState) => {
      const current = (page.attachments ?? []).map(key).sort()
      return current.length === expected.length && current.every((name, index) => name === expected[index])
    }
    const incompatible = (cards: NonNullable<GptProPageState["attachments"]>) =>
      cards.length > files.length ||
      cards.some((attachment) => attachment.name && !expectedNames.has(attachment.name)) ||
      cards.some((attachment) => attachment.status === "ready" && !expected.includes(key(attachment)))
    let page = await this.page()
    if (!page.targetModel) throw new Error("Model evidence changed before attachment upload")
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
      if (!mayDispatch) throw new Error("Attachment upload state is ambiguous after recovery; no duplicate upload was attempted")
      if (!page.attachmentInput) throw new Error("ChatGPT's verified attachment input is unavailable")
      this.log(`driver dispatching attachment upload count=${files.length}`)
      await this.cdp().setInputFiles(attachmentInputSelector, files.map((file) => file.path))
    }
    let last = ""
    for (let attempt = 0; attempt < 240; attempt++) {
      if (shouldContinue && !(await shouldContinue())) throw new Error("Attachment workflow was cancelled")
      page = await this.page()
      if (page.error) throw new GptProPageError(page.error.message, page.error.kind)
      if (!page.targetModel) throw new Error("Model evidence changed during attachment upload")
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
    return {
      composer: await cdp.matches(uid, editorSelector),
      send: await cdp.matches(uid, `${sendSelector},button[type="submit"]`),
      retry:
        (await cdp.matches(
          uid,
          '[data-testid*="retry" i],[data-testid*="regenerate" i],button[aria-label*="Retry" i],button[aria-label*="Regenerate" i]',
        )) || (await cdp.matchesText(uid, "^(?:retry|try again|regenerate(?: response)?)$")),
    }
  }
  recover() {
    this.rejected = undefined
    this.log(
      "driver agent recovery cleared historical request rejection; rendered errors and verification remain enforced",
    )
  }
  async submit(beforeDispatch?: () => Promise<void>, uid?: string) {
    this.log("driver waiting for enabled Chat send control")
    for (let i = 0; i < 20; i++) {
      const page = await this.page()
      if (page.error) throw new GptProPageError(page.error.message, page.error.kind)
      if (page.sendReady) {
        if (!page.targetModel)
          throw new GptProPageError("The selected model changed before sending. Nothing was dispatched.")
        this.log("driver dispatching one trusted send-button click")
        if (uid) await this.cdp().click(uid, undefined, beforeDispatch)
        else
          await this.cdp().clickSelector(
            sendSelector
              .split(",")
              .map((selector) => selector + ':not(:disabled):not([aria-disabled="true"])')
              .join(","),
            beforeDispatch,
          )
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
