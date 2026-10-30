export type DocumentInput = {
  format: "png" | "pdf" | "markdown"
  name: string
  markdown?: string
  html?: string
  width?: number
  theme?: "light" | "dark"
}

export function validateDocument(value: unknown): DocumentInput {
  if (!value || typeof value !== "object") throw new Error("Invalid export input")
  const input = value as DocumentInput
  if (!["png", "pdf", "markdown"].includes(input.format)) throw new Error("Unsupported export format")
  if (typeof input.name !== "string" || input.name.length > 200) throw new Error("Invalid export name")
  if (input.width !== undefined && (!Number.isInteger(input.width) || input.width < 200 || input.width > 2400))
    throw new Error("Invalid export width")
  if (input.theme !== undefined && input.theme !== "light" && input.theme !== "dark")
    throw new Error("Invalid export theme")
  if (input.format === "markdown" && (typeof input.markdown !== "string" || Buffer.byteLength(input.markdown) > 8 * 1024 * 1024))
    throw new Error("Markdown export exceeds the 8 MiB limit")
  if (input.format !== "markdown" && (typeof input.html !== "string" || Buffer.byteLength(input.html) > 32 * 1024 * 1024))
    throw new Error("Export document exceeds the 32 MiB limit")
  if (input.format !== "markdown" && input.html && (input.html.match(/</g)?.length ?? 0) > 200_000) throw new Error("Export document contains too many elements")
  if (typeof (input.format === "markdown" ? input.markdown : input.html) !== "string")
    throw new Error("Missing export content")
  return {
    format: input.format,
    name: input.name,
    markdown: input.format === "markdown" ? input.markdown : undefined,
    html: input.format === "markdown" ? undefined : input.html,
    width: input.width,
    theme: input.theme,
  }
}

export function documentName(name: string) {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
      .replace(/^[. ]+|[. ]+$/g, "")
      .slice(0, 120) || "session"
  )
}

// Multiple CSP policies intersect: content cannot loosen this policy using another meta tag.
export function isolatedHTML(html: string, theme?: "light" | "dark") {
  return `<!doctype html><html style="color-scheme:${theme ?? "light"}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html{margin:0}body{margin:0;overflow-wrap:anywhere}*{animation:none!important;transition:none!important}img{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`
}

export function pngSlices(height: number) {
  if (!Number.isFinite(height) || height < 1 || height > 200_000)
    throw new Error("Export document height exceeds limit")
  const total = Math.ceil(height)
  return Array.from({ length: Math.ceil(total / 4096) }, (_, index) => ({
    y: index * 4096,
    height: Math.min(4096, total - index * 4096),
  }))
}
