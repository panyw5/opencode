import { describe, expect, test } from "bun:test"
import {
  DEFAULT_TIMELINE_OVERSCAN,
  isWindowsElectron,
  timelineOverscan,
  WINDOWS_TIMELINE_OVERSCAN,
} from "./windows-performance"

describe("Windows Electron timeline performance", () => {
  test("enables the Windows desktop path only for Windows Electron", () => {
    expect(isWindowsElectron("Mozilla/5.0 (Windows NT 10.0) Electron/41.2.1")).toBe(true)
    expect(isWindowsElectron("Mozilla/5.0 (Macintosh) Electron/41.2.1")).toBe(false)
    expect(isWindowsElectron("Mozilla/5.0 (Windows NT 10.0) Chrome/140.0")).toBe(false)
  })

  test("keeps the existing overscan on macOS Electron", () => {
    expect(timelineOverscan("Mozilla/5.0 (Macintosh) Electron/41.2.1")).toBe(DEFAULT_TIMELINE_OVERSCAN)
  })

  test("reduces normal overscan on Windows Electron", () => {
    expect(timelineOverscan("Mozilla/5.0 (Windows NT 10.0) Electron/41.2.1")).toBe(WINDOWS_TIMELINE_OVERSCAN)
  })
})
