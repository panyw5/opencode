import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { validateSvgSource } from "@/session/presentation"
import * as Log from "@opencode-ai/core/util/log"
import * as Tool from "./tool"
import DESCRIPTION from "./present_diagram.txt"

export const Parameters = Schema.Struct({
  syntax: Schema.Literals(["svg", "mermaid", "flowchart"]),
  source: Schema.String.annotate({
    description:
      "Raw SVG or Mermaid source without a Markdown code fence, or a JSON flowchart spec when syntax is flowchart",
  }),
  title: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
})

export type DiagramInput = Schema.Schema.Type<typeof Parameters>

const MAX_SOURCE_BYTES = 64 * 1024
const MAX_FLOWCHART_NODES = 200
const MAX_FLOWCHART_EDGES = 500
const MAX_FLOWCHART_LABEL = 200
const FLOWCHART_DIRECTIONS = new Set(["TD", "LR", "BT", "RL"])
const FLOWCHART_STYLES = new Set(["solid", "dashed", "thick"])
const FLOWCHART_SHAPES: Record<string, [string, string]> = {
  rect: ["[", "]"],
  round: ["(", ")"],
  stadium: ["([", "])"],
  diamond: ["{", "}"],
  circle: ["((", "))"],
  subroutine: ["[[", "]]"],
  hexagon: ["{{", "}}"],
  parallelogram: ["[/", "/]"],
}
const FLOWCHART_ARROWS: Record<string, string> = {
  solid: "-->",
  dashed: "-.->",
  thick: "==>",
}
const FLOWCHART_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/
// Mermaid flowchart statement keywords break diagrams when used as node ids
// ("end" in particular), so they are transparently remapped to "n_<id>".
const FLOWCHART_RESERVED =
  /^(end|subgraph|direction|graph|flowchart|style|linkstyle|classdef|class|click|call|default)$/i
const log = Log.create({ service: "tool.present_diagram" })

function sanitizeFlowchartLabel(label: string) {
  return Array.from(label.replace(/["`\\|]/g, " ").replace(/\s+/g, " ").trim())
    .slice(0, MAX_FLOWCHART_LABEL)
    .join("")
}

/**
 * Compile a structured flowchart JSON spec into Mermaid flowchart source so the
 * renderer can treat flowcharts like any other Mermaid diagram. Errors are
 * descriptive on purpose: they surface as tool failures the model can correct.
 */
export function compileFlowchart(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("flowchart source must be a JSON object with optional direction, nodes, and edges")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("flowchart source must be a JSON object with optional direction, nodes, and edges")
  }
  const spec = parsed as Record<string, unknown>
  const direction = typeof spec.direction === "string" ? spec.direction.toUpperCase() : "TD"
  if (!FLOWCHART_DIRECTIONS.has(direction)) {
    throw new Error("flowchart direction must be one of TD, LR, BT, RL")
  }
  const edges = spec.edges
  if (!Array.isArray(edges) || edges.length === 0) {
    throw new Error("flowchart requires a nonempty edges array")
  }
  if (edges.length > MAX_FLOWCHART_EDGES) {
    throw new Error(`flowchart supports at most ${MAX_FLOWCHART_EDGES} edges`)
  }
  const ids = new Map<string, string>()
  const declared = new Map<string, string>()
  const register = (rawID: unknown, rawLabel?: unknown, rawShape?: unknown): string => {
    if (typeof rawID !== "string" || !FLOWCHART_ID.test(rawID)) {
      throw new Error(`flowchart node id must match ${FLOWCHART_ID.source}, got ${JSON.stringify(rawID)}`)
    }
    const known = ids.get(rawID)
    if (known) return known
    const id = FLOWCHART_RESERVED.test(rawID) ? `n_${rawID}` : rawID
    ids.set(rawID, id)
    if (ids.size > MAX_FLOWCHART_NODES) {
      throw new Error(`flowchart supports at most ${MAX_FLOWCHART_NODES} nodes`)
    }
    const shape = typeof rawShape === "string" ? rawShape : undefined
    if (shape && !FLOWCHART_SHAPES[shape]) {
      throw new Error(`flowchart node shape must be one of ${Object.keys(FLOWCHART_SHAPES).join(", ")}`)
    }
    const label = sanitizeFlowchartLabel(typeof rawLabel === "string" ? rawLabel : "")
    if (!shape && !label && id === rawID) return id
    const text = label || rawID
    const [open, close] = FLOWCHART_SHAPES[shape ?? "rect"]
    declared.set(id, `${id}${open}"${text}"${close}`)
    return id
  }
  const nodes = spec.nodes
  if (nodes !== undefined) {
    if (!Array.isArray(nodes)) throw new Error("flowchart nodes must be an array")
    for (const item of nodes) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("flowchart nodes must be objects with an id")
      }
      const node = item as Record<string, unknown>
      register(node.id, node.label, node.shape)
    }
  }
  for (const item of edges) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("flowchart edges must be objects with from and to")
    }
    const edge = item as Record<string, unknown>
    if (typeof edge.from !== "string" || typeof edge.to !== "string") {
      throw new Error("flowchart edge requires string from and to")
    }
    register(edge.from)
    register(edge.to)
  }
  const lines = [`flowchart ${direction}`]
  for (const declaration of declared.values()) lines.push(`  ${declaration}`)
  for (const item of edges) {
    const edge = item as Record<string, unknown>
    const from = ids.get(edge.from as string)!
    const to = ids.get(edge.to as string)!
    const style = typeof edge.style === "string" ? edge.style : "solid"
    if (!FLOWCHART_STYLES.has(style)) {
      throw new Error(`flowchart edge style must be one of ${[...FLOWCHART_STYLES].join(", ")}`)
    }
    const label = sanitizeFlowchartLabel(typeof edge.label === "string" ? edge.label : "")
    const arrow = FLOWCHART_ARROWS[style]
    // Quote edge labels: unquoted text breaks on special characters like parentheses.
    lines.push(`  ${from} ${label ? `${arrow}|"${label}"|` : arrow} ${to}`)
  }
  return lines.join("\n")
}

export function prepareDiagram(input: DiagramInput) {
  const source = input.source.trim()
  if (!source) throw new Error("present_diagram requires nonempty source")
  const bytes = Buffer.byteLength(source, "utf8")
  if (bytes > MAX_SOURCE_BYTES) throw new Error("present_diagram source exceeds 64 KiB")
  if (input.syntax === "svg") validateSvgSource(source)
  const mermaid = input.syntax === "flowchart" ? compileFlowchart(source) : undefined
  const title = Array.from(
    input.title?.trim() ||
      (input.syntax === "svg" ? "SVG diagram" : input.syntax === "flowchart" ? "Flowchart" : "Mermaid diagram"),
  )
    .slice(0, 120)
    .join("")
  const caption = input.caption ? Array.from(input.caption.trim()).slice(0, 240).join("") : undefined
  const diagramID = `dg_${createHash("sha256").update(input.syntax).update("\0").update(source).digest("hex").slice(0, 32)}`
  return { diagramID, syntax: input.syntax, source, title, caption, bytes, mermaid }
}

export const PresentDiagramTool = Tool.define(
  "present_diagram",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (input: DiagramInput) =>
      Effect.try({
        try: () => {
          const diagram = prepareDiagram(input)
          log.info("diagram presented", { id: diagram.diagramID, syntax: diagram.syntax, bytes: diagram.bytes })
          return {
            title: diagram.title,
            metadata: {
              diagram: {
                id: diagram.diagramID,
                syntax: diagram.syntax,
                title: diagram.title,
                caption: diagram.caption,
                bytes: diagram.bytes,
                ...(diagram.mermaid ? { mermaid: diagram.mermaid } : {}),
              },
            },
            output: `Presented ${diagram.syntax} diagram: ${diagram.title}.`,
          }
        },
        catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
      }).pipe(Effect.orDie),
  }),
)
