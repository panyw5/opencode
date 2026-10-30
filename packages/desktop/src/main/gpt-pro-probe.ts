import { GPT_PRO_PARTITION, GPT_PRO_URL, type GptProPageState, type GptProProbeStatus } from "@opencode-ai/util/gpt-pro"
import { CHATGPT_INSPECT_EXPRESSION } from "@opencode-ai/util/chatgpt-page"
import type { BrowserController } from "./browser"
import type { BrowserCdp } from "./browser-cdp"
import { getGptProSessionCoordinator } from "./gpt-pro-session-coordinator"

type ProbeBrowser = Pick<BrowserController, "has" | "open" | "getState" | "present"> & {
  openPage?: BrowserController["openPage"]
  cdp(pageID: string): (Pick<BrowserCdp, "evaluate"> & Partial<Pick<BrowserCdp, "waitForDocument">>) | undefined
}

export class GptProProbe {
  constructor(
    private browser: ProbeBrowser,
    private log: (message: string) => void = () => {},
    private profile: () => string = () => GPT_PRO_PARTITION,
  ) {}
  private coordinator() {
    return getGptProSessionCoordinator(this.browser, this.profile(), this.log)
  }
  async open(): Promise<GptProProbeStatus> {
    const id = this.profile()
    if (!this.browser.has(id)) {
      if (this.browser.openPage) await this.browser.openPage(id, id, GPT_PRO_URL, { kind: "login" })
      else await this.browser.open(id, GPT_PRO_URL)
    }
    this.browser.present(id)
    await this.browser.cdp(id)?.waitForDocument?.()
    await this.coordinator().verify()
    this.log(`login page explicitly presented profile=${id}; existing documents and drafts preserved`)
    return this.status()
  }
  async status(): Promise<GptProProbeStatus> {
    return { partition: this.profile(), session: this.coordinator().snapshot() }
  }
  authentication() {
    return this.coordinator().verify()
  }
  /** Expensive explicit diagnostics are not a status or authentication path. */
  async inspect() {
    const id = this.profile()
    const before = this.browser.getState().find((view) => (view.pageID ?? view.partition) === id)
    if (!before || before.loading) return
    const page = await this.browser.cdp(id)?.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
    const after = this.browser.getState().find((view) => (view.pageID ?? view.partition) === id)
    if (
      !after ||
      before.epoch !== after.epoch ||
      before.documentEpoch !== after.documentEpoch ||
      before.url !== after.url
    )
      throw new Error("Page changed during explicit diagnostic inspection")
    return page
  }
}
