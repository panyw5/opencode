import type { BrowserBounds } from "./types"

const selector = [
  '[data-component="popover-content"]',
  '[data-component="dropdown-menu-content"]',
  '[data-component="dropdown-menu-sub-content"]',
  '[data-component="tooltip"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
].join(",")

export function browserOverlay(bounds: BrowserBounds, root: ParentNode = document): string | undefined {
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    // The enlarged browser dialog owns the native surface, not an overlay on it.
    if (element.hasAttribute("data-browser-maximized")) continue
    if (element.hasAttribute("data-closed") || element.getAttribute("data-state") === "closed") continue
    const style = getComputedStyle(element)
    if (style.display === "none" || style.visibility === "hidden") continue
    const rect = element.getBoundingClientRect()
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left < bounds.x + bounds.width &&
      rect.right > bounds.x &&
      rect.top < bounds.y + bounds.height &&
      rect.bottom > bounds.y
    )
      return element.getAttribute("data-component") ?? element.getAttribute("role") ?? "overlay"
  }
}
