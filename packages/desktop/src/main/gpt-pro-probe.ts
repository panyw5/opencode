import {
  GPT_PRO_PARTITION,
  GPT_PRO_URL,
  isGptProOrigin,
  isGptProLoginUrl,
  type GptProPageState,
  type GptProProbeStatus,
  type GptProRuntimeStatus,
} from "@opencode-ai/util/gpt-pro"
import type { BrowserController } from "./browser"
import type { BrowserCdp } from "./browser-cdp"
import { CHATGPT_INSPECT_EXPRESSION } from "@opencode-ai/util/chatgpt-page"
import { readGptProAuthentication } from "./gpt-pro-authentication"

type ProbeBrowser = Pick<BrowserController, "has" | "open" | "getState" | "present"> & {
  openPage?: BrowserController["openPage"]
  cdp(partition: string): Pick<BrowserCdp, "evaluate"> | undefined
}

export class GptProProbe {
  constructor(
    private readonly browser: ProbeBrowser,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async open(): Promise<GptProProbeStatus> {
    this.log("probe open: opening dedicated persistent Chat browser")
    // Do not navigate an existing conversation: opening diagnostics must not
    // interrupt a manually started Pro response or erase an unsent draft.
    if (!this.browser.has(GPT_PRO_PARTITION)) {
      if (this.browser.openPage)
        await this.browser.openPage(GPT_PRO_PARTITION, GPT_PRO_PARTITION, GPT_PRO_URL, { kind: "login" })
      else await this.browser.open(GPT_PRO_PARTITION, GPT_PRO_URL)
    }
    this.browser.present(GPT_PRO_PARTITION)
    return this.status()
  }

  async status(): Promise<GptProProbeStatus> {
    const state = this.browser.getState().find((view) => view.partition === GPT_PRO_PARTITION)
    const result = (phase: GptProProbeStatus["phase"], detail?: string, page?: GptProPageState): GptProProbeStatus => ({
      phase,
      partition: GPT_PRO_PARTITION,
      ...(detail ? { detail } : {}),
      ...(page ? { page } : {}),
    })
    if (!state) return result("not_open")
    if (state.loading) return result("loading")
    if (!isGptProOrigin(state.url)) {
      if (isGptProLoginUrl(state.url)) return result("needs_login", "Finish login in the gpt-pro browser tab.")
      return result("blocked", "The gpt-pro browser is on a non-ChatGPT origin; no message was sent.")
    }
    if (isGptProLoginUrl(state.url)) return result("needs_login", "Finish login in the gpt-pro browser tab.")
    const cdp = this.browser.cdp(GPT_PRO_PARTITION)
    if (!cdp) return result("not_open")
    const page = await cdp.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
    if (!isGptProOrigin(page.url)) {
      if (isGptProLoginUrl(page.url)) return result("needs_login", "Finish login in the gpt-pro browser tab.", page)
      return result("blocked", "The page changed origin during inspection.", page)
    }
    if (isGptProLoginUrl(page.url)) return result("needs_login", "Finish login in the gpt-pro browser tab.", page)
    this.log(
      `probe inspect: model=${page.model} composer=${page.composer} generating=${page.generating} users=${page.users.length} revision=${page.revision} htmlChars=${page.answer?.html.length ?? 0} complete=${page.answer?.complete ?? false}`,
    )
    if (page.error) {
      this.log(`probe blocked kind=${page.error.kind}`)
      return result(page.error.kind === "verification" ? "needs_login" : "blocked", page.error.message, page)
    }
    if (!page.composer) return result("loading", "The ChatGPT composer is not visible yet; no message was sent.", page)
    this.log(
      `probe model observation label=${JSON.stringify(page.model || "unknown")} policy=user-selected nonblocking=true`,
    )
    if (page.generating) return result("tracking", undefined, page)
    if (page.answer?.complete) return result("completed", undefined, page)
    return result("ready", undefined, page)
  }
  async authentication(): Promise<GptProRuntimeStatus["authentication"]> {
    const views = this.browser.getState().filter((view) => (view.profileID ?? view.partition) === GPT_PRO_PARTITION)
    let observed: GptProRuntimeStatus["authentication"] = {
      phase: views.length ? "loading" : "unknown",
      checkedAt: Date.now(),
    }
    for (const view of views) {
      if (view.loading) continue
      if (isGptProLoginUrl(view.url)) {
        observed = { phase: "needs_login", checkedAt: Date.now() }
        continue
      }
      if (!isGptProOrigin(view.url)) continue
      const cdp = this.browser.cdp(view.pageID ?? view.partition)
      if (!cdp) continue
      try {
        const [auth, page] = await Promise.all([
          readGptProAuthentication(cdp),
          cdp.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION),
        ])
        const current = this.browser
          .getState()
          .find((current) => (current.pageID ?? current.partition) === (view.pageID ?? view.partition))
        if (!current || current.epoch !== view.epoch || !isGptProOrigin(page.url)) continue
        const result: GptProRuntimeStatus["authentication"] = {
          ...auth,
          phase: page.error?.kind === "verification" ? "verification" : auth.phase,
          model: page.model || undefined,
          detail: page.error?.message,
          checkedAt: Date.now(),
        }
        this.log(
          `runtime authentication inspected pageID=${view.pageID ?? view.partition} phase=${result.phase} composer=${page.composer}; identity omitted`,
        )
        if (result.phase === "authenticated" && page.composer) return result
        observed = result
      } catch {
        this.log(`runtime authentication inspection unavailable pageID=${view.pageID ?? view.partition}`)
      }
    }
    return observed
  }
}
