// Snapshot the real Markdown DOM, including resolved app/theme styles. The
// receiving window is inert: it never parses Markdown or runs document scripts.
const forbidden = "button,script,iframe,style,link,object,embed,foreignObject"

export async function waitForShareRender(preview: HTMLElement) {
  const deadline = Date.now() + 30_000
  while (!preview.querySelector('[data-markdown-rendered-stage="full"]')) {
    if (Date.now() > deadline) throw new Error("Export render timeout")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await document.fonts.ready
  await Promise.all(Array.from(preview.querySelectorAll("img"), (image) => image.decode().catch(() => {})))
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

function clean(root: HTMLElement) {
  root.querySelectorAll(forbidden).forEach((node) => node.remove())
  for (const node of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of Array.from(node.attributes)) {
      if (/^on|^srcset$|^style$/i.test(attribute.name)) node.removeAttribute(attribute.name)
    }
  }
  root.querySelectorAll("img").forEach((img) => {
    if (!/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(img.getAttribute("src") ?? ""))
      img.replaceWith(document.createTextNode(img.alt || "Image"))
  })
  root.querySelectorAll("[data-code-collapse]").forEach((node) => {
    node.removeAttribute("data-code-collapse")
    node.setAttribute("data-code-expanded", "true")
  })
}

export function shareBody(preview: HTMLElement) {
  const clone = preview.cloneNode(true) as HTMLElement
  clean(clone)
  return clone.innerHTML
}

async function dataURL(url: URL) {
  const response = await fetch(url.href)
  if (!response.ok) throw new Error("Could not embed export asset")
  const blob = await response.blob()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid export asset"))
    reader.onerror = () => reject(new Error("Could not read export asset"))
    reader.readAsDataURL(blob)
  })
}

async function fontStyles(families: Set<string>) {
  const faces: { css: string; base: string }[] = []
  const visit = (rules: CSSRuleList, base: string) => {
    for (const rule of Array.from(rules)) {
      if (rule.type === 5 && "style" in rule) {
        const face = rule as CSSFontFaceRule
        const family = face.style.getPropertyValue("font-family").replace(/["']/g, "").trim()
        if (families.has(family)) faces.push({ css: rule.cssText, base })
      } else if (!("selectorText" in rule) && (rule as CSSGroupingRule).cssRules)
        visit((rule as CSSGroupingRule).cssRules, base)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules, sheet.href || document.baseURI)
    } catch {
      /* Cross-origin stylesheets cannot contribute export assets. */
    }
  }
  const cache = new Map<string, Promise<string>>()
  return (
    await Promise.all(
      faces.map(async ({ css, base }) => {
        for (const match of Array.from(css.matchAll(/url\(["']?([^)'"\s]+)["']?\)/g))) {
          const url = new URL(match[1], base)
          if (url.protocol === "data:") continue
          if (url.origin !== location.origin || !/\.woff2?(?:$|\?)/i.test(url.href)) {
            css = css.replace(match[0], "url(data:;base64,)")
            continue
          }
          if (!cache.has(url.href)) cache.set(url.href, dataURL(url))
          css = css.replace(match[0], `url("${await cache.get(url.href)}")`)
        }
        return css
      }),
    )
  ).join("\n")
}

async function inlineSprites(root: HTMLElement) {
  const cache = new Map<string, Promise<Document>>()
  const symbols = new Map<string, string>()
  for (const [index, use] of Array.from(root.querySelectorAll("use")).entries()) {
    const href = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? ""
    const url = new URL(href, document.baseURI)
    const key = url.href
    let source: Element | null = null
    if (href.startsWith("#")) source = document.getElementById(href.slice(1))
    else if (url.origin === location.origin && /\.svg$/i.test(url.pathname) && url.hash) {
      const hash = url.hash.slice(1)
      url.hash = ""
      if (!cache.has(url.href))
        cache.set(
          url.href,
          fetch(url.href).then(async (response) => {
            if (!response.ok) throw new Error("Could not embed export icon")
            return new DOMParser().parseFromString(await response.text(), "image/svg+xml")
          }),
        )
      source = (await cache.get(url.href))!.getElementById(hash)
    }
    if (!source) throw new Error("Could not resolve export icon")
    const existing = symbols.get(key)
    if (existing) {
      use.setAttribute("href", `#${existing}`)
      use.removeAttribute("xlink:href")
      continue
    }
    const symbol = source.cloneNode(true) as Element
    const id = `export-icon-${index}`
    symbols.set(key, id)
    symbol.id = id
    use.parentElement?.prepend(symbol)
    use.setAttribute("href", `#${id}`)
    use.removeAttribute("xlink:href")
  }
}

export async function shareHTML(preview: HTMLElement, theme: "light" | "dark") {
  console.debug("[session-share] snapshot start")
  const clone = preview.cloneNode(true) as HTMLElement
  const rules = new Map<string, string>()
  const families = new Set<string>()
  const sources = [preview, ...preview.querySelectorAll("*")]
  const targets = [clone, ...clone.querySelectorAll("*")]
  const resolve = (source: Element, pseudo?: string) => {
    const style = getComputedStyle(source, pseudo)
    style.fontFamily.split(",").forEach((family) => families.add(family.replace(/["']/g, "").trim()))
    // Computed values preserve native Markdown, Shiki, KaTeX and icon geometry,
    // independently of ancestor selectors or viewport media queries in the app.
    return Array.from(style)
      .filter((key) => !key.startsWith("--") && !/^(animation|transition)/.test(key))
      .map((key) => `${key}:${style.getPropertyValue(key).replace(/url\([^)]*\)/gi, "none")};`)
      .join("")
  }
  const pseudoRules: string[] = []
  sources.forEach((source, index) => {
    const css = resolve(source)
    if (!rules.has(css)) rules.set(css, `s${rules.size}`)
    targets[index].classList.add(`export-style-${rules.get(css)}`)
    for (const pseudo of ["::before", "::after"]) {
      const content = getComputedStyle(source, pseudo).content
      if (!content || content === "none" || content === "normal") continue
      pseudoRules.push(`.export-node-${index}${pseudo}{${resolve(source, pseudo)}}`)
      targets[index].classList.add(`export-node-${index}`)
    }
  })
  console.debug(`[session-share] styles resolved nodes=${sources.length} rules=${rules.size}`)
  await inlineSprites(clone)
  clean(clone)
  const fonts = await fontStyles(families)
  // Style elements contain trusted computed CSS, not text from Markdown.
  const css = [...rules].map(([style, name]) => `.export-style-${name}{${style}}`).join("\n")
  console.debug(`[session-share] snapshot bytes=${new Blob([fonts + css + pseudoRules.join("\n") + clone.outerHTML]).size}`)
  const width = Math.ceil(preview.getBoundingClientRect().width)
  clone.style.cssText = `margin:0;width:${width}px;min-height:0;max-height:none;position:relative!important;left:0!important;right:auto!important;top:0!important;bottom:auto!important;inset-inline-start:0!important;inset-inline-end:auto!important;transform:none!important;`
  console.debug(`[session-share] snapshot complete width=${width}`)
  return `<style>${(fonts + css + pseudoRules.join("\n")).replace(/<\/style/gi, "<\\/style")}</style><div style="color-scheme:${theme}">${clone.outerHTML}</div>`
}
