export type DiagramSyntax = "svg" | "mermaid"
export type DiagramTheme = "light" | "dark"
export type DiagramPalette = {
  key: string
  scheme: DiagramTheme
  background: string
  surface: string
  surfaceStrong: string
  text: string
  textWeak: string
  border: string
  borderStrong: string
  accent: string
  fontFamily: string
}

const MAX_CACHE_ENTRIES = 24
const cache = new Map<string, string>()
let mermaidModule: Promise<(typeof import("mermaid"))["default"]> | undefined
let renderTail: Promise<void> = Promise.resolve()
let sequence = 0

export function currentDiagramPalette(): DiagramPalette {
  const root = typeof document === "undefined" ? undefined : document.documentElement
  const style = root ? getComputedStyle(root) : undefined
  const scheme: DiagramTheme = root?.dataset.colorScheme === "dark" ? "dark" : "light"
  const token = (name: string, fallback: string) => style?.getPropertyValue(name).trim() || fallback
  const palette = {
    scheme,
    background: token("--background-base", scheme === "dark" ? "#141413" : "#ffffff"),
    surface: token("--surface-raised-base", scheme === "dark" ? "#1f1e1d" : "#f5f4f1"),
    surfaceStrong: token("--background-stronger", scheme === "dark" ? "#262624" : "#eeede9"),
    text: token("--text-strong", scheme === "dark" ? "#faf9f5" : "#242320"),
    textWeak: token("--text-weak", scheme === "dark" ? "#b0aea5" : "#6f6d67"),
    border: token("--border-weak-base", scheme === "dark" ? "#30302e" : "#deddd8"),
    borderStrong: token("--border-strong-base", scheme === "dark" ? "#5e5d59" : "#aaa8a0"),
    accent: token("--text-interactive-base", scheme === "dark" ? "#df8a6d" : "#a44e32"),
    fontFamily: typeof document === "undefined" ? "sans-serif" : getComputedStyle(document.body).fontFamily,
  }
  return { ...palette, key: [root?.dataset.theme ?? "", ...Object.values(palette)].join("|") }
}

export function svgAspectRatio(svg: string): number | undefined {
  const viewBox = svg.match(/\bviewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)["']/i)
  if (!viewBox) return
  const width = Number(viewBox[1])
  const height = Number(viewBox[2])
  if (!(width > 0 && height > 0)) return
  return width / height
}

function labelColor(fill: string | undefined, theme: DiagramTheme) {
  const hex = fill?.match(/(?:^|[;\s])fill\s*:\s*#([0-9a-f]{3}|[0-9a-f]{6})(?:\s|;|!|$)/i)?.[1]
  if (!hex) return theme === "dark" ? "#faf9f5" : "#242320"
  const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex
  const rgb = [0, 2, 4].map((offset) => parseInt(expanded.slice(offset, offset + 2), 16) / 255)
  const linear = rgb.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  return luminance < 0.18 ? "#faf9f5" : "#242320"
}

export function mixDiagramColor(base: string, accent: string, amount: number) {
  const parse = (value: string) => {
    const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1]
    if (!hex) return
    const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex
    return [0, 2, 4].map((offset) => parseInt(expanded.slice(offset, offset + 2), 16))
  }
  const from = parse(base)
  const to = parse(accent)
  if (!from || !to) return base
  const weight = Math.max(0, Math.min(1, amount))
  return `#${from
    .map((value, index) =>
      Math.round(value * (1 - weight) + to[index] * weight)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

function applyDiagramPalette(element: SVGSVGElement, palette: DiagramPalette) {
  const variables = {
    "--oc-diagram-background": palette.background,
    "--oc-diagram-surface": palette.surface,
    "--oc-diagram-surface-strong": palette.surfaceStrong,
    "--oc-diagram-text": palette.text,
    "--oc-diagram-line": palette.textWeak,
    "--oc-diagram-border": palette.borderStrong,
    "--oc-diagram-accent": palette.accent,
  }
  for (const [name, value] of Object.entries(variables)) element.style.setProperty(name, value)
  if (!element.style.color) element.style.setProperty("color", "var(--oc-diagram-text)")
  if (!element.style.fill && !element.getAttribute("fill")) element.style.setProperty("fill", "var(--oc-diagram-text)")
  if (!element.style.fontFamily) element.style.setProperty("font-family", palette.fontFamily)

  const shades = [
    mixDiagramColor(palette.surfaceStrong, palette.accent, 0.07),
    mixDiagramColor(palette.surface, palette.accent, 0.1),
    mixDiagramColor(palette.background, palette.accent, 0.04),
  ]
  const clusterBorder = mixDiagramColor(palette.borderStrong, palette.accent, 0.18)
  element.style.setProperty("--oc-diagram-cluster-border", clusterBorder)
  for (const [index, cluster] of [...element.querySelectorAll(".cluster")].entries()) {
    const variant = index % shades.length
    const fill = `var(--oc-diagram-cluster-${variant})`
    const textColor = `var(--oc-diagram-cluster-text-${variant})`
    element.style.setProperty(`--oc-diagram-cluster-${variant}`, shades[variant])
    element.style.setProperty(
      `--oc-diagram-cluster-text-${variant}`,
      labelColor(`fill:${shades[variant]}`, palette.scheme),
    )
    const rect = cluster.querySelector(":scope > rect") as SVGElement | null
    rect?.style.setProperty("fill", fill, "important")
    rect?.style.setProperty("stroke", "var(--oc-diagram-cluster-border)", "important")
    for (const text of cluster.querySelectorAll(".cluster-label text, .cluster-label tspan")) {
      ;(text as SVGElement).style.setProperty("fill", textColor, "important")
    }
    for (const text of cluster.querySelectorAll(".cluster-label div, .cluster-label span, .cluster-label p")) {
      ;(text as HTMLElement).style.setProperty("color", textColor, "important")
    }
  }
}

export function normalizeMermaidSvg(svg: string, palette: DiagramPalette = currentDiagramPalette()) {
  const html = new DOMParser().parseFromString(svg, "text/html")
  const element = html.querySelector("svg") as SVGSVGElement | null
  if (!element) throw new Error("Mermaid did not produce an SVG element")
  applyDiagramPalette(element, palette)
  const normalized = new XMLSerializer().serializeToString(element)
  const parsed = new DOMParser().parseFromString(normalized, "image/svg+xml")
  if (parsed.querySelector("parsererror")) throw new Error("Mermaid produced invalid SVG")
  return normalized
}

export function themeSvgSource(source: string, palette: DiagramPalette) {
  const document = new DOMParser().parseFromString(source, "image/svg+xml")
  if (document.querySelector("parsererror") || document.documentElement.localName !== "svg") {
    throw new Error("Invalid SVG diagram")
  }
  const svg = document.documentElement as unknown as SVGSVGElement
  applyDiagramPalette(svg, palette)
  return new XMLSerializer().serializeToString(svg)
}

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
          flowchart: { htmlLabels: false, look: "classic" },
          look: "classic",
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

export function renderDiagramSvg(input: {
  id: string
  syntax: DiagramSyntax
  source: string
  palette?: DiagramPalette
}): Promise<string> {
  if (input.syntax === "svg") return Promise.resolve(input.source)
  const palette = input.palette ?? currentDiagramPalette()
  const key = `${palette.key}:${input.id}`
  const cached = cache.get(key)
  if (cached) return Promise.resolve(cached)

  const task = renderTail.then(async () => {
    const engine = await mermaid()
    engine.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      maxTextSize: 64 * 1024,
      maxEdges: 500,
      suppressErrorRendering: true,
      flowchart: { htmlLabels: false, look: "classic" },
      look: "classic",
      theme: "base",
      themeVariables: {
        darkMode: palette.scheme === "dark",
        background: palette.background,
        primaryColor: palette.surfaceStrong,
        primaryTextColor: palette.text,
        primaryBorderColor: palette.borderStrong,
        secondaryColor: palette.surface,
        secondaryTextColor: palette.text,
        secondaryBorderColor: palette.border,
        tertiaryColor: palette.background,
        tertiaryTextColor: palette.text,
        tertiaryBorderColor: palette.border,
        clusterBkg: palette.surface,
        clusterBorder: palette.borderStrong,
        lineColor: palette.textWeak,
        textColor: palette.text,
        fontFamily: palette.fontFamily,
      },
    })
    const { svg } = await engine.render(`opencode_diagram_${++sequence}`, input.source)
    const normalized = normalizeMermaidSvg(svg, palette)
    cache.delete(key)
    cache.set(key, normalized)
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
    return normalized
  })
  renderTail = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}
