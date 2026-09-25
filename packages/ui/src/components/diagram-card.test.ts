import { describe, expect, test } from "bun:test"
import { readDiagramMetadata } from "./diagram-card"
import { mixDiagramColor, renderDiagramSvg, svgAspectRatio } from "./diagram-render"

describe("diagram card", () => {
  test("reads Mermaid source from the tool input", () => {
    expect(
      readDiagramMetadata(
        { source: "flowchart LR\n  A --> B" },
        { diagram: { id: "dg_1", syntax: "mermaid", title: "Flow", caption: "Overview", bytes: 21 } },
      ),
    ).toEqual({ id: "dg_1", syntax: "mermaid", source: "flowchart LR\n  A --> B", title: "Flow", caption: "Overview" })
  })

  test("rejects incomplete metadata and source", () => {
    expect(readDiagramMetadata({}, { diagram: { id: "dg_1", syntax: "svg" } })).toBeUndefined()
    expect(readDiagramMetadata({ source: "<svg/>" }, { diagram: { id: "dg_1", syntax: "dot" } })).toBeUndefined()
  })

  test("renders inline SVG without loading Mermaid", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"/>'
    expect(await renderDiagramSvg({ id: "dg_svg", syntax: "svg", source })).toBe(source)
  })

  test("detects tall SVG view boxes for width-first preview", () => {
    expect(svgAspectRatio('<svg viewBox="4 4 713.6 5027.8"/>')).toBeLessThan(0.5)
    expect(svgAspectRatio('<svg viewBox="0 0 200 100"/>')).toBe(2)
    expect(svgAspectRatio("<svg/>")).toBeUndefined()
  })

  test("mixes theme colors without changing unsupported color formats", () => {
    expect(mixDiagramColor("#ffffff", "#000000", 0.5)).toBe("#808080")
    expect(mixDiagramColor("rgba(0,0,0,.5)", "#ffffff", 0.5)).toBe("rgba(0,0,0,.5)")
  })
})
