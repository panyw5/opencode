/** Only inspect mounted, visible rows during initial positioning, never the full history. */
function participatesInLayout(element: HTMLElement) {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden"
}

export function initialTimelineLayoutReady(root: HTMLElement) {
  const viewport = root.getBoundingClientRect()
  const rows = root.querySelectorAll<HTMLElement>("[data-timeline-key]")
  if (!rows.length) return true
  let visible = false
  for (const row of rows) {
    const box = row.getBoundingClientRect()
    if (box.bottom <= viewport.top || box.top >= viewport.bottom) continue
    visible = true
    if ([...row.querySelectorAll<HTMLElement>('[data-tool-placeholder="true"]')].some(participatesInLayout))
      return false
    for (const markdown of row.querySelectorAll<HTMLElement>('[data-component="markdown"]')) {
      if (!participatesInLayout(markdown)) continue
      // A stable estimated height does not mean the async Markdown parse landed.
      if (markdown.dataset.markdownRenderedStage !== "full") return false
    }
  }
  return visible
}

/** A data-cache hit alone cannot bypass loading: verify the actual cached viewport before paint. */
export type CachedTimelineInspection = {
  ready: boolean
  reason: string
  repairs: Array<{ key: string; height: number }>
}

export function inspectCachedTimelineLayout(
  root: HTMLElement,
  cachedHeight: (key: string) => number | undefined,
): CachedTimelineInspection {
  const repairs: CachedTimelineInspection["repairs"] = []
  const miss = (reason: string) => ({ ready: false, reason, repairs })
  if (!initialTimelineLayoutReady(root)) return miss("content-pending")
  const viewport = root.getBoundingClientRect()
  const boxes: DOMRect[] = []
  for (const row of root.querySelectorAll<HTMLElement>("[data-timeline-key]")) {
    const box = row.getBoundingClientRect()
    if (box.bottom <= viewport.top || box.top >= viewport.bottom) continue
    if ([...row.querySelectorAll<HTMLElement>('[data-markdown-fallback="true"]')].some(participatesInLayout))
      return miss("markdown-fallback")
    const key = row.dataset.timelineKey ?? ""
    const height = cachedHeight(key)
    const content = row.firstElementChild
    if (height === undefined || !Number.isFinite(height) || height <= 0) return miss("measurement-missing")
    if (!(content instanceof HTMLElement)) return miss("content-missing")
    const measured = content.offsetHeight
    if (!Number.isFinite(measured) || measured <= 0) return miss("content-unmeasured")
    if (Math.abs(measured - height) > 1) repairs.push({ key, height: measured })
    boxes.push(box)
  }
  if (repairs.length) return miss("height-mismatch")
  if (!boxes.length) return miss("viewport-empty")
  let covered = viewport.top
  for (const box of boxes.sort((a, b) => a.top - b.top)) {
    if (box.top > covered + 1) return miss("viewport-hole")
    covered = Math.max(covered, box.bottom)
  }
  // The timeline reserves 64px of end padding below its last row.
  return root.scrollHeight <= root.clientHeight + 1 || covered >= viewport.bottom - 65
    ? { ready: true, reason: "validated", repairs }
    : miss("viewport-incomplete")
}

export function cachedTimelineLayoutReady(root: HTMLElement, cachedHeight: (key: string) => number | undefined) {
  return inspectCachedTimelineLayout(root, cachedHeight).ready
}
