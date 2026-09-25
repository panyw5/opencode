import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { validateSvgSource } from "@/session/presentation"
import * as Log from "@opencode-ai/core/util/log"
import * as Tool from "./tool"
import DESCRIPTION from "./present_diagram.txt"

export const Parameters = Schema.Struct({
  syntax: Schema.Literals(["svg", "mermaid"]),
  source: Schema.String.annotate({ description: "Raw SVG or Mermaid source, without a Markdown code fence" }),
  title: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
})

export type DiagramInput = Schema.Schema.Type<typeof Parameters>

const MAX_SOURCE_BYTES = 64 * 1024
const log = Log.create({ service: "tool.present_diagram" })

export function prepareDiagram(input: DiagramInput) {
  const source = input.source.trim()
  if (!source) throw new Error("present_diagram requires nonempty source")
  const bytes = Buffer.byteLength(source, "utf8")
  if (bytes > MAX_SOURCE_BYTES) throw new Error("present_diagram source exceeds 64 KiB")
  if (input.syntax === "svg") validateSvgSource(source)
  const title = Array.from(input.title?.trim() || (input.syntax === "svg" ? "SVG diagram" : "Mermaid diagram"))
    .slice(0, 120)
    .join("")
  const caption = input.caption ? Array.from(input.caption.trim()).slice(0, 240).join("") : undefined
  const diagramID = `dg_${createHash("sha256").update(input.syntax).update("\0").update(source).digest("hex").slice(0, 32)}`
  return { diagramID, syntax: input.syntax, source, title, caption, bytes }
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
              },
            },
            output: `Presented ${diagram.syntax} diagram: ${diagram.title}.`,
          }
        },
        catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
      }).pipe(Effect.orDie),
  }),
)
