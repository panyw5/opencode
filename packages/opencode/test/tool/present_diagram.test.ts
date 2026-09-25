import { describe, expect, test } from "bun:test"
import { prepareDiagram } from "../../src/tool/present_diagram"

describe("present_diagram", () => {
  test("accepts Mermaid without requiring a file", () => {
    const diagram = prepareDiagram({ syntax: "mermaid", source: "flowchart LR\n  A --> B", title: "  Flow  " })
    expect(diagram.syntax).toBe("mermaid")
    expect(diagram.source).toBe("flowchart LR\n  A --> B")
    expect(diagram.title).toBe("Flow")
    expect(diagram.diagramID).toStartWith("dg_")
    expect(diagram.bytes).toBe(Buffer.byteLength(diagram.source))
  })

  test("accepts static SVG and rejects executable SVG", () => {
    expect(
      prepareDiagram({ syntax: "svg", source: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>' })
        .title,
    ).toBe("SVG diagram")
    expect(() => prepareDiagram({ syntax: "svg", source: '<svg onload="alert(1)"/>' })).toThrow("unsafe")
  })

  test("rejects empty or oversized source", () => {
    expect(() => prepareDiagram({ syntax: "mermaid", source: "  " })).toThrow("nonempty")
    expect(() => prepareDiagram({ syntax: "mermaid", source: "a".repeat(64 * 1024 + 1) })).toThrow("64 KiB")
  })
})
