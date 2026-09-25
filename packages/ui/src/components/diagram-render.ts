export type DiagramSyntax = "svg" | "mermaid"

const MAX_CACHE_ENTRIES = 24
const cache = new Map<string, string>()
let mermaidModule: Promise<(typeof import("mermaid"))["default"]> | undefined
let renderTail: Promise<void> = Promise.resolve()
let sequence = 0

function mermaid() {
  if (!mermaidModule) {
    mermaidModule = import("mermaid")
      .then((module) => {
        const instance = module.default
        instance.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          maxTextSize: 64 * 1024,
          maxEdges: 500,
          suppressErrorRendering: true,
          flowchart: { htmlLabels: false },
        })
        return instance
      })
      .catch((error) => {
        mermaidModule = undefined
        throw error
      })
  }
  return mermaidModule
}

export function renderDiagramSvg(input: { id: string; syntax: DiagramSyntax; source: string }): Promise<string> {
  if (input.syntax === "svg") return Promise.resolve(input.source)
  const cached = cache.get(input.id)
  if (cached) return Promise.resolve(cached)

  const task = renderTail.then(async () => {
    const engine = await mermaid()
    const { svg } = await engine.render(`opencode_diagram_${++sequence}`, input.source)
    cache.delete(input.id)
    cache.set(input.id, svg)
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
    return svg
  })
  renderTail = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}
