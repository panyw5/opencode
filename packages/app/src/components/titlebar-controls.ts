export type TitlebarAreaRect = {
  x: number
  width: number
}

export type WindowControlsOverlayLike = {
  visible?: boolean
  getTitlebarAreaRect?: () => TitlebarAreaRect
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

/** Windows 11 caption buttons are typically 46 CSS px each. */
export const WINDOWS_CAPTION_FALLBACK_PX = 138
/** Keep a small gap so titlebar actions do not sit flush against min/max/close. */
export const TITLEBAR_CONTROLS_GAP_PX = 8

const MIN_CAPTION_INSET_PX = 32
const MAX_CAPTION_INSET_PX = 240

export function titlebarControlsWidth(
  area: TitlebarAreaRect | undefined,
  viewportWidth: number,
  fallback = WINDOWS_CAPTION_FALLBACK_PX,
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return fallback
  if (!area) return fallback
  if (!Number.isFinite(area.x) || !Number.isFinite(area.width) || area.width <= 0) return fallback

  const inset = Math.round(viewportWidth - area.x - area.width)
  const maxInset = Math.min(MAX_CAPTION_INSET_PX, Math.floor(viewportWidth * 0.45))
  if (inset < MIN_CAPTION_INSET_PX || inset > maxInset) return fallback
  return inset
}

export function titlebarControlsPadding(inset: number, gap = TITLEBAR_CONTROLS_GAP_PX): number {
  if (!Number.isFinite(inset) || inset <= 0) return 0
  return inset + Math.max(0, gap)
}

export function windowControlsOverlay(
  nav: { windowControlsOverlay?: WindowControlsOverlayLike } | undefined,
): WindowControlsOverlayLike | undefined {
  return nav?.windowControlsOverlay
}
