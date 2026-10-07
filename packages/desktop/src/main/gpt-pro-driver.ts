import {
  CHATGPT_INSPECT_EXPRESSION,
  CHATGPT_MODEL_PICKER_EXPRESSION,
  CHATGPT_ONBOARDING_DISMISS_EXPRESSION,
} from "@opencode-ai/util/chatgpt-page"
import { GPT_PRO_PARTITION, GPT_PRO_URL, isGptProOrigin, type GptProPageState } from "@opencode-ai/util/gpt-pro"
import type { BrowserController } from "./browser"
import { GptProPageError } from "./gpt-pro-page-error"

const sendSelector =
  '[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Send"],button[aria-label="发送消息"],button[aria-label="发送提示"]'

const editorSelector = '#prompt-textarea, [data-composer-markdown][role="textbox"][contenteditable="true"]'
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
      if (page.draft.trim())
        throw new Error("A manual draft is present. It will not be erased to start a consultation.")
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
          if (new URL(page.url).pathname === "/" && page.composer && !page.users.length && !page.draft.trim()) {
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
    const page = await this.cdp().evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
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
  async element(uid: string) {
    return {
      composer: await this.cdp().matches(uid, editorSelector),
      send: await this.cdp().matches(uid, `${sendSelector},button[type="submit"]`),
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
