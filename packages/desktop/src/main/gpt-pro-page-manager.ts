import type { BrowserController } from "./browser"
import { GPT_PRO_URL } from "@opencode-ai/util/gpt-pro"

export async function openGptProCandidatePage(
  browser: Pick<BrowserController, "getState" | "cdp" | "has" | "openPage">,
  profileID: string,
  log: (message: string) => void,
) {
  if (!browser.has(profileID)) await browser.openPage(profileID, profileID, GPT_PRO_URL, { kind: "login" }, "login_candidate")
  const before = browser.getState().find((view) => view.pageID === profileID)
  if (!before || before.profileID !== profileID) throw new Error("Login candidate page is unavailable")
  if (before.loading) {
    log(`login candidate document barrier started profile=${profileID}; no reload dispatched`)
    const cdp = browser.cdp(profileID)
    if (!cdp) throw new Error("Login candidate page closed while loading")
    await cdp.waitForDocument()
  }
  const current = browser.getState().find((view) => view.pageID === profileID)
  if (!current || current.epoch !== before.epoch || current.profileID !== profileID || current.loading)
    throw new Error("Login candidate page changed while awaiting its document")
  log(`login candidate document barrier settled profile=${profileID} documentEpoch=${current.documentEpoch ?? 0}`)
}
