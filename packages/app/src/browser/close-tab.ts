import type { CommandSource } from "@/context/command"

export const CLOSE_BROWSER_TAB_COMMAND = "browserTabs.close"

export function browserPanelHasFocus(doc: Document = document) {
  return [...doc.querySelectorAll<HTMLElement>("#browser-panel, [data-browser-maximized]")].some(
    (panel) =>
      panel.getAttribute("aria-hidden") !== "true" && !panel.hasAttribute("inert") && panel.contains(doc.activeElement),
  )
}

export function closeFocusedBrowserTab(
  source: CommandSource | undefined,
  trigger: (id: string, source?: CommandSource) => void,
) {
  if ((source !== "menu" && source !== "keybind") || !browserPanelHasFocus()) return false
  console.debug(`[browser-tab-close] route source=${source} target=browser-chrome`)
  trigger(CLOSE_BROWSER_TAB_COMMAND, source)
  return true
}
