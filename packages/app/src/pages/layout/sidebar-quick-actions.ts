export const SIDEBAR_ACTION_BUTTON_WIDTH = 40
export const SIDEBAR_ACTION_MIN_GAP = 2
export const SIDEBAR_ACTION_CHROME_WIDTH = 8

export function visibleSidebarActionCount(width: number, actionCount: number) {
  if (actionCount <= 0) return 0

  const available = Math.max(0, width - SIDEBAR_ACTION_CHROME_WIDTH)
  const capacity = Math.floor(
    (available + SIDEBAR_ACTION_MIN_GAP) / (SIDEBAR_ACTION_BUTTON_WIDTH + SIDEBAR_ACTION_MIN_GAP),
  )

  // Once any action is hidden, one slot belongs to the primary action and one
  // to the overflow menu.
  if (capacity >= actionCount + 1) return actionCount
  return Math.max(0, Math.min(actionCount - 1, capacity - 2))
}
