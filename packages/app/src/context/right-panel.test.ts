import { describe, expect, test } from "bun:test"
import { restoreRightPanel, toggleRightPanel, rightPanelGeometry } from "./right-panel"

describe("right panel state", () => {
  test("the file tree remains independent of the mutually exclusive wide panel", () => {
    expect(rightPanelGeometry("none", false, 600, 344)).toEqual({
      wide: false,
      opened: false,
      width: "0px",
      sessionWidth: "100%",
    })
    expect(rightPanelGeometry("none", true, 600, 344)).toEqual({
      wide: false,
      opened: true,
      width: "344px",
      sessionWidth: "calc(100% - 344px)",
    })
    for (const active of ["review", "filePreview", "browser"] as const) {
      expect(rightPanelGeometry(active, true, 600, 344).width).toBe("calc(100% - 600px)")
    }
  })
  test("migrates legacy flags into one deterministic selection", () => {
    expect(
      restoreRightPanel({ browser: { opened: true }, filePreview: { opened: true }, review: { panelOpened: true } }),
    ).toBe("browser")
    expect(restoreRightPanel({ filePreview: { opened: true } })).toBe("filePreview")
    expect(restoreRightPanel({ review: { panelOpened: false } })).toBe("none")
    expect(restoreRightPanel({})).toBe("review")
  })
  test("preserves the new selection regardless of legacy flags", () => {
    for (const active of ["none", "review", "filePreview", "browser"] as const) {
      expect(restoreRightPanel({ rightPanel: { active }, browser: { opened: true } })).toBe(active)
    }
  })
  test("switches directly between panels and toggles only the selected one closed", () => {
    expect(toggleRightPanel("review", "browser")).toBe("browser")
    expect(toggleRightPanel("browser", "filePreview")).toBe("filePreview")
    expect(toggleRightPanel("filePreview", "filePreview")).toBe("none")
  })
})
