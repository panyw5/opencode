import { mkdir } from "node:fs/promises"
import { rgbToHex, hexToOklch } from "../../ui/src/theme/color"
import { contrastRatio } from "../../ui/src/theme/contrast"
import { DEFAULT_THEMES } from "../../ui/src/theme/default-themes"
import { resolveThemeVariant } from "../../ui/src/theme/resolve"
import { surfaceChromaLimit } from "../../ui/src/theme/surfaces"
import { withCdp } from "./cdp"

const output = Bun.env.THEME_AUDIT_OUTPUT ?? "/tmp/opencode-theme-accents"
const selected = Bun.env.THEME_AUDIT_IDS?.split(",") ?? Object.keys(DEFAULT_THEMES).sort()
const log = (message: string) => console.info(`[theme-accents] ${message}`)

function inspect(keys: string[]) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const context = canvas.getContext("2d", { willReadFrequently: true })!
  const rgba = (value: string) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data]
  }
  const over = (fg: number[], bg: number[]) =>
    fg.slice(0, 3).map((v, i) => (v * fg[3]) / 255 + bg[i] * (1 - fg[3] / 255))
  const background = (el: Element) => {
    const layers: number[][] = []
    for (let p: Element | null = el; p; p = p.parentElement) layers.unshift(rgba(getComputedStyle(p).backgroundColor))
    return layers.reduce((bg, fg) => over(fg, bg), [255, 255, 255])
  }
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.left >= innerWidth || r.bottom <= 0 || r.top >= innerHeight)
      return false
    for (let p: Element | null = el; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.display === "none" || s.visibility === "hidden" || s.contentVisibility === "hidden" || +s.opacity < 0.98)
        return false
    }
    const hit = document.elementFromPoint(
      Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)),
      Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2)),
    )
    return !!hit && (el.contains(hit) || hit.contains(el))
  }
  const tabs = [
    ...document.querySelectorAll(
      '[data-component="session-tab"][data-active="true"], [data-slot="tabs-trigger-wrapper"]:has([data-selected])',
    ),
  ]
    .filter(visible)
    .map((el) => ({
      kind: el.matches('[data-component="session-tab"]') ? "session" : "file-or-navigation",
      bg: background(el),
      fg: over(rgba(getComputedStyle(el).color), background(el)),
    }))
  const swatch = document.createElement("div")
  swatch.style.cssText = "position:fixed;left:-10000px;width:1px;height:1px"
  document.body.appendChild(swatch)
  const surfaces = keys.map((key) => {
    swatch.style.backgroundColor = `var(--${key})`
    return { key, bg: background(swatch) }
  })
  swatch.remove()
  return { tabs, surfaces, width: innerWidth }
}

await mkdir(output, { recursive: true })
await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Only audit the development renderer")
  const original = await cdp.evaluate<{ id: string; mode: string }>(
    `({id:document.documentElement.dataset.theme,mode:document.documentElement.dataset.colorScheme})`,
  )
  const switchTheme = async (id: string, mode: string) => {
    await cdp.evaluate(`(() => {
      window.dispatchEvent(new StorageEvent('storage',{key:'opencode-color-scheme',newValue:${JSON.stringify(mode)}}));
      window.dispatchEvent(new StorageEvent('storage',{key:'opencode-theme-id',newValue:${JSON.stringify(id)}}));
    })()`)
    for (let i = 0; i < 100; i++) {
      if (
        await cdp.evaluate(
          `document.documentElement.dataset.theme===${JSON.stringify(id)}&&document.documentElement.dataset.colorScheme===${JSON.stringify(mode)}`,
        )
      ) {
        await Bun.sleep(180)
        return
      }
      await Bun.sleep(50)
    }
    throw new Error(`Theme switch timed out ${id} ${mode}`)
  }
  const hex = (rgb: number[]) => rgbToHex(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)
  const results = []
  try {
    for (const id of selected) {
      for (const mode of ["light", "dark"] as const) {
        await switchTheme(id, mode)
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 800, y: 500 })
        const keys = Object.keys(resolveThemeVariant(DEFAULT_THEMES[id][mode], mode === "dark")).filter(
          (key) => surfaceChromaLimit(key, mode === "dark") !== undefined,
        )
        const page = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})(${JSON.stringify(keys)})`)
        const tabs = page.tabs.map((tab) => ({
          ...tab,
          background: hex(tab.bg),
          chroma: hexToOklch(hex(tab.bg)).c,
          ratio: contrastRatio(hex(tab.fg), hex(tab.bg)),
        }))
        const surfaces = page.surfaces.map((surface) => ({
          key: surface.key,
          background: hex(surface.bg),
          chroma: hexToOklch(hex(surface.bg)).c,
          maximum: surfaceChromaLimit(surface.key, mode === "dark")!,
        }))
        const failures = [
          ...tabs.filter((tab) => tab.chroma > (mode === "dark" ? 0.043 : 0.033) || tab.ratio < 4.5),
          ...surfaces.filter((surface) => surface.chroma > surface.maximum + 0.003),
        ]
        if (!tabs.some((tab) => tab.kind === "session"))
          throw new Error(`Missing real active session tab ${id} ${mode}`)
        if (!tabs.some((tab) => tab.kind === "file-or-navigation"))
          throw new Error(`Open a safe file preview before auditing ${id} ${mode}`)
        results.push({ id, mode, tabs, surfaces, failures })
        await Bun.write(`${output}/results.json`, JSON.stringify(results, null, 2))
        // Only capture tab headers, never the file contents or conversation below them.
        const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", {
          format: "png",
          clip: { x: 0, y: 0, width: page.width, height: 90, scale: 1 },
        })
        await Bun.write(`${output}/${id}-${mode}-tabs.png`, Buffer.from(shot.data, "base64"))
        log(
          `${id} ${mode} tabs=${tabs.length} surfaces=${surfaces.length} maxTabChroma=${Math.max(...tabs.map((t) => t.chroma)).toFixed(4)} failures=${failures.length}`,
        )
      }
    }
    const failures = results.flatMap((r) => r.failures.map((item) => ({ id: r.id, mode: r.mode, ...item })))
    log(`completed variants=${results.length} failures=${failures.length} output=${output}`)
    if (failures.length) throw new Error(`${failures.length} accent failures; see ${output}/results.json`)
  } finally {
    await switchTheme(original.id, original.mode)
    log(`restored theme=${original.id} mode=${original.mode}`)
  }
})
