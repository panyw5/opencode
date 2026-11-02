/** Only inspect mounted, visible rows during initial positioning, never the full history. */
export function initialTimelineLayoutReady(root: HTMLElement) {
  const viewport = root.getBoundingClientRect()
  const rows = root.querySelectorAll<HTMLElement>("[data-timeline-key]")
  if (!rows.length) return true
  let visible = false
  for (const row of rows) {
    const box = row.getBoundingClientRect()
    if (box.bottom <= viewport.top || box.top >= viewport.bottom) continue
    visible = true
    for (const markdown of row.querySelectorAll<HTMLElement>('[data-component="markdown"]')) {
      // A stable estimated height does not mean the async Markdown parse landed.
      if (markdown.dataset.markdownRenderedStage !== "full") return false
    }
  }
  return visible
}
