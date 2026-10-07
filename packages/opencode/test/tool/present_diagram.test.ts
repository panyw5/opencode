import { describe, expect, test } from "bun:test"
import { compileFlowchart, prepareDiagram } from "../../src/tool/present_diagram"

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

  test("compiles a structured flowchart spec to Mermaid", () => {
    const spec = {
      direction: "LR",
      nodes: [
        { id: "start", label: "Start", shape: "stadium" },
        { id: "end", label: "Done" },
      ],
      edges: [
        { from: "start", to: "work", label: "begin" },
        { from: "work", to: "end", style: "dashed", label: "skip checks" },
      ],
    }
    const diagram = prepareDiagram({ syntax: "flowchart", source: JSON.stringify(spec) })
    expect(diagram.syntax).toBe("flowchart")
    expect(diagram.title).toBe("Flowchart")
    expect(diagram.mermaid).toBe(
      'flowchart LR\n  start(["Start"])\n  n_end["Done"]\n  start -->|"begin"| work\n  work -.->|"skip checks"| n_end',
    )
  })

  test("derives undeclared nodes from edges and defaults direction to TD", () => {
    const mermaid = compileFlowchart(JSON.stringify({ edges: [{ from: "a", to: "b", style: "thick" }] }))
    expect(mermaid).toBe("flowchart TD\n  a ==> b")
  })

  test("rejects invalid flowchart specs with actionable errors", () => {
    expect(() => compileFlowchart("not json")).toThrow("JSON object")
    expect(() => compileFlowchart('{"edges": []}')).toThrow("nonempty edges")
    expect(() => compileFlowchart('{"direction": "UP", "edges": [{"from": "a", "to": "b"}]}')).toThrow(
      "direction must be one of",
    )
    expect(() => compileFlowchart('{"edges": [{"from": "a b", "to": "c"}]}')).toThrow("node id")
    expect(() => compileFlowchart('{"edges": [{"from": "a", "to": "b", "style": "wavy"}]}')).toThrow(
      "style must be one of",
    )
    expect(() => compileFlowchart('{"nodes": [{"id": "a", "shape": "blob"}], "edges": [{"from": "a", "to": "b"}]}'))
      .toThrow("shape must be one of")
    expect(() => compileFlowchart('{"nodes": [{"id": "a"}, {"id": "a"}], "edges": [{"from": "a", "to": "b"}]}')).not.toThrow()
  })

  test("remaps reserved Mermaid keywords used as node ids", () => {
    const mermaid = compileFlowchart(
      JSON.stringify({
        nodes: [{ id: "end", label: "Done", shape: "stadium" }],
        edges: [{ from: "start", to: "end" }],
      }),
    )
    expect(mermaid).toBe('flowchart TD\n  n_end(["Done"])\n  start --> n_end')
  })

  test("sanitizes hostile labels", () => {
    const mermaid = compileFlowchart(
      JSON.stringify({
        nodes: [{ id: "a", label: 'say "hi"\nnow' }],
        edges: [{ from: "a", to: "b", label: "p|ipe" }],
      }),
    )
    expect(mermaid).toContain('a["say hi now"]')
    expect(mermaid).toContain('|"p ipe"|')
  })
})
