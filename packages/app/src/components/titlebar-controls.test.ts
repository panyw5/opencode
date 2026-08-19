import { describe, expect, test } from "bun:test"
import {
  TITLEBAR_CONTROLS_GAP_PX,
  WINDOWS_CAPTION_FALLBACK_PX,
  titlebarControlsPadding,
  titlebarControlsWidth,
} from "./titlebar-controls"

describe("titlebar controls inset", () => {
  test("uses the overlay-reported caption width", () => {
    expect(titlebarControlsWidth({ x: 0, width: 1142 }, 1280)).toBe(138)
  })

  test("falls back when the overlay area is missing or not ready", () => {
    expect(titlebarControlsWidth(undefined, 1280)).toBe(WINDOWS_CAPTION_FALLBACK_PX)
    expect(titlebarControlsWidth({ x: 0, width: 1280 }, 1280)).toBe(WINDOWS_CAPTION_FALLBACK_PX)
    expect(titlebarControlsWidth({ x: 0, width: 0 }, 1280)).toBe(WINDOWS_CAPTION_FALLBACK_PX)
  })

  test("falls back for implausible insets", () => {
    expect(titlebarControlsWidth({ x: 0, width: 10 }, 1280)).toBe(WINDOWS_CAPTION_FALLBACK_PX)
    expect(titlebarControlsWidth({ x: 0, width: 20 }, 80)).toBe(WINDOWS_CAPTION_FALLBACK_PX)
  })

  test("accepts wider caption clusters on scaled Windows displays", () => {
    expect(titlebarControlsWidth({ x: 0, width: 1100 }, 1280)).toBe(180)
  })

  test("padding adds a gap so actions sit left of the caption buttons", () => {
    expect(titlebarControlsPadding(138)).toBe(138 + TITLEBAR_CONTROLS_GAP_PX)
    expect(titlebarControlsPadding(0)).toBe(0)
  })
})
