import { withCdp } from "./cdp"

// Run against the dev renderer: bun packages/desktop/scripts/verify-popup-surfaces.ts
await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Expected the development desktop renderer")
  console.info("[popup-surfaces] checking desktop backgrounds across themes, schemes and operating systems")
  const result = await cdp.evaluate<{ checks: number; failures: string[] }>(String.raw`(() => {
    const root = document.documentElement
    const attributes = ["data-theme", "data-color-scheme", "data-platform", "data-os", "style"]
    const original = attributes.map(name => [name, root.getAttribute(name)])
    const host = document.createElement("div")
    host.style.cssText = "position:fixed;left:-10000px;pointer-events:none;--surface-raised-stronger-non-alpha:light-dark(rgb(249,248,246),rgb(48,48,46))"
    const components = ["popover-content", "dropdown-menu-content", "dropdown-menu-sub-content",
      "context-menu-content", "context-menu-sub-content", "select-content", "hover-card-content"]
    const panels = components.map(name => {
      const element = document.createElement("div")
      element.dataset.component = name
      host.append(element)
      return element
    })
    // Include a utility background to catch cascade regressions in custom dialogs.
    const dialog = document.createElement("div")
    dialog.dataset.component = "dialog"
    const content = document.createElement("div")
    content.dataset.slot = "dialog-content"
    content.className = "bg-background-base"
    dialog.append(content)
    host.append(dialog)
    panels.push(content)
    const arrows = ["popover-arrow", "dropdown-menu-arrow", "context-menu-arrow"].map(slot => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
      svg.dataset.slot = slot
      host.append(svg)
      return svg
    })
    const failures = []
    let checks = 0
    document.body.append(host)
    try {
      root.dataset.platform = "desktop"
      for (const theme of ["oc-2", "claude", "chatgpt", "arc", "aether"]) {
        root.dataset.theme = theme
        for (const scheme of ["light", "dark"]) {
          root.dataset.colorScheme = scheme
          root.style.colorScheme = scheme
          const expected = scheme === "light" ? "rgb(249, 248, 246)" : "rgb(48, 48, 46)"
          for (const os of ["macos", "windows", "linux"]) {
            root.dataset.os = os
            for (const panel of panels) {
              const style = getComputedStyle(panel)
              const name = panel.dataset.component || panel.dataset.slot
              checks++
              if (style.backgroundColor !== expected || style.backgroundImage !== "none" || style.backdropFilter !== "none") {
                failures.push(theme + "/" + scheme + "/" + os + "/" + name +
                  " background=" + style.backgroundColor + " blur=" + style.backdropFilter)
              }
            }
            for (const arrow of arrows) {
              checks++
              if (getComputedStyle(arrow).fill !== expected) failures.push("Arrow mismatch: " + arrow.dataset.slot)
            }
          }
        }
      }
      return { checks, failures }
    } finally {
      host.remove()
      for (const [name, value] of original) {
        if (value === null) root.removeAttribute(name)
        else root.setAttribute(name, value)
      }
    }
  })()`)
  for (const failure of result.failures) console.error(`[popup-surfaces] ${failure}`)
  if (result.failures.length) throw new Error(`${result.failures.length}/${result.checks} popup surface checks failed`)
  console.info(`[popup-surfaces] passed ${result.checks} background, blur and arrow checks`)
})
