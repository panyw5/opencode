import { expect, test } from "bun:test"
import { shareImageLayout, shareImageLayouts, sharePreviewScale } from "./session-share-layout"
import { shareHTML } from "./session-share-html"

test("device presets keep readable logical typography at supported export widths", () => {
  expect(shareImageLayouts.map((layout) => layout.width)).toEqual([750, 1170, 1536, 1920, 2400])
  for (const preset of shareImageLayouts) {
    const layout = shareImageLayout(preset.id)
    expect(layout.width).toBeLessThanOrEqual(2400)
    expect((layout.fontSize * layout.viewport) / layout.width).toBeCloseTo(16)
    expect(layout.paperStyle.width).toBe(`${layout.width}px`)
    expect((parseFloat(layout.paperStyle["--share-padding"]) * layout.viewport) / layout.width).toBeCloseTo(
      layout.padding,
    )
  }
  const phone = shareImageLayout("phone")
  const hd = shareImageLayout("phone-hd")
  expect(phone.width / phone.fontSize).toBeCloseTo(hd.width / hd.fontSize)
  expect(hd.fontSize / hd.width).toBeGreaterThan(shareImageLayout("mac").fontSize / 1920)
})

test("preview fits narrow and wide windows without changing export resolution", () => {
  for (const available of [320, 600, 1024, 1728]) {
    for (const { width } of shareImageLayouts) {
      const scale = sharePreviewScale(available, width)
      expect(scale).toBeLessThanOrEqual(1)
      expect(width * scale).toBeLessThanOrEqual(available + 0.000001)
    }
  }
  expect(sharePreviewScale(0, 1170)).toBe(1)
})

test("HTML snapshot uses unscaled paper width, not the zoomed preview bounds", async () => {
  const paper = document.createElement("div")
  paper.style.width = "1170px"
  paper.innerHTML = '<p style="font-size:48px">Readable on a phone</p>'
  Object.defineProperty(paper, "offsetWidth", { value: 1170 })
  paper.getBoundingClientRect = () => ({ width: 390 }) as DOMRect
  document.body.append(paper)
  try {
    const html = await shareHTML(paper, "light")
    expect(html).toContain("width:1170px")
    expect(html).toContain("font-size:48px")
    expect(html).not.toContain("width:390px")
  } finally {
    paper.remove()
  }
})
