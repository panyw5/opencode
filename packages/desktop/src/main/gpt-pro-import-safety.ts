import {
  GPT_PRO_PARTITION,
  isGptProOrigin,
  type GptProPageState,
  type GptProRuntimeStatus,
} from "@opencode-ai/util/gpt-pro"
import { CHATGPT_INSPECT_EXPRESSION } from "@opencode-ai/util/chatgpt-page"
import type { BrowserController } from "./browser"

export async function inspectGptProImportSafety(
  browser: Pick<BrowserController, "getState" | "cdp">,
  log: (message: string) => void,
) {
  const blockers: GptProRuntimeStatus["blockers"] = []
  const pages = browser.getState().filter((view) => (view.profileID ?? view.partition) === GPT_PRO_PARTITION)
  for (const view of pages) {
    const pageID = view.pageID ?? view.partition
    const cdp = browser.cdp(pageID)
    let blocked = view.loading || !isGptProOrigin(view.url) || !cdp
    let phase: GptProRuntimeStatus["blockers"][number]["phase"] = "preparing"
    if (!blocked && cdp) {
      try {
        const page = await cdp.evaluate<GptProPageState>(CHATGPT_INSPECT_EXPRESSION)
        const current = browser.getState().find((current) => (current.pageID ?? current.partition) === pageID)
        blocked =
          !current ||
          current.epoch !== view.epoch ||
          !!(page.generating || page.draft.trim() || page.attachments?.length)
        phase = page.generating ? "generating" : "paused"
      } catch {
        blocked = true
      }
    }
    if (blocked) blockers.push({ id: `browser:${pageID}`, phase, ownerPage: view.owner })
    log(`login-import safety pageID=${pageID} blocked=${blocked} phase=${phase}; page content omitted`)
  }
  return { pages, blockers }
}
