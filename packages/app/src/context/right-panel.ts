export type RightPanel = "none" | "review" | "filePreview" | "browser"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function restoreRightPanel(value: unknown): RightPanel {
  if (!record(value)) return "review"
  const active = record(value.rightPanel) ? value.rightPanel.active : undefined
  if (active === "none" || active === "review" || active === "filePreview" || active === "browser") return active
  if (record(value.browser) && value.browser.opened === true) return "browser"
  if (record(value.filePreview) && value.filePreview.opened === true) return "filePreview"
  if (record(value.review) && value.review.panelOpened === false) return "none"
  return "review"
}

export function toggleRightPanel(active: RightPanel, target: Exclude<RightPanel, "none">): RightPanel {
  return active === target ? "none" : target
}

export function rightPanelGeometry(active: RightPanel, tree: boolean, sessionWidth: number, treeWidth: number) {
  const wide = active !== "none"
  const opened = wide || tree
  return {
    wide,
    opened,
    width: !opened ? "0px" : wide ? `calc(100% - ${sessionWidth}px)` : `${treeWidth}px`,
    sessionWidth: !opened ? "100%" : wide ? `${sessionWidth}px` : `calc(100% - ${treeWidth}px)`,
  }
}
