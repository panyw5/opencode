import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { DEFAULT_THEMES } from "../../ui/src/theme/default-themes"
import { withCdp } from "./cdp"

const output = resolve(Bun.env.TOOLTIP_AUDIT_OUTPUT ?? ".artifacts/tooltip-contrast")
const selected = Bun.env.THEME_AUDIT_IDS?.split(",") ?? Object.keys(DEFAULT_THEMES).sort()
const selectors: Record<string, string> | undefined = Bun.env.TOOLTIP_AUDIT_SELECTORS
  ? JSON.parse(Bun.env.TOOLTIP_AUDIT_SELECTORS)
  : undefined
const log = (message: string) => console.log(`[tooltip-contrast] ${message}`)

// Inspect every text node, including secondary text, path segments, keybinds and highlights.
function inspect() {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!
  const rgba = (value: string) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    return [...ctx.getImageData(0, 0, 1, 1).data].map((v, i) => (i === 3 ? v / 255 : v))
  }
  const over = (a: number[], b: number[]) => [...a.slice(0, 3).map((v, i) => v * a[3] + b[i] * (1 - a[3])), 1]
  const lum = (a: number[]) =>
    a.slice(0, 3).reduce((sum, v, i) => {
      const n = v / 255
      return sum + [0.2126, 0.7152, 0.0722][i] * (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
    }, 0)
  const rows = []
  for (const tooltip of document.querySelectorAll(
    '[data-component="tooltip"][data-expanded], [data-component="project-rail-label"]',
  )) {
    const walker = document.createTreeWalker(tooltip, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent?.trim()
      const el = walker.currentNode.parentElement
      if (!text || !el) continue
      const chain: Element[] = []
      for (let p: Element | null = el; p; p = p.parentElement) chain.unshift(p)
      const styles = chain.map((p) => getComputedStyle(p))
      if (styles.some((s) => s.display === "none" || s.visibility === "hidden" || +s.opacity === 0)) continue
      const bg = styles.reduce((bg, s) => over(rgba(s.backgroundColor), bg), [255, 255, 255, 1])
      const fg = rgba(getComputedStyle(el).color)
      fg[3] *= styles.reduce((a, s) => a * +s.opacity, 1)
      const a = lum(over(fg, bg))
      const b = lum(bg)
      rows.push({
        text,
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        color: getComputedStyle(el).color,
        background: bg,
        class: el.className,
      })
    }
  }
  return rows
}

await mkdir(output, { recursive: true })
await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Use the development Electron renderer only")
  await cdp.call("Page.bringToFront")
  await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true })
  const original = await cdp.evaluate<{ theme: string; mode: string }>(
    `({ theme:document.documentElement.dataset.theme, mode:document.documentElement.dataset.colorScheme })`,
  )
  const results: { theme: string; mode: string; target: string; rows: ReturnType<typeof inspect> }[] = []
  const switchTheme = async (theme: string, mode: string) => {
    await cdp.evaluate(
      `window.dispatchEvent(new StorageEvent('storage',{key:'opencode-color-scheme',newValue:${JSON.stringify(mode)}}));window.dispatchEvent(new StorageEvent('storage',{key:'opencode-theme-id',newValue:${JSON.stringify(theme)}}))`,
    )
    for (let i = 0; i < 100; i++) {
      if (
        await cdp.evaluate(
          `document.documentElement.dataset.theme===${JSON.stringify(theme)}&&document.documentElement.dataset.colorScheme===${JSON.stringify(mode)}`,
        )
      )
        return
      await Bun.sleep(50)
    }
    throw new Error(`Theme switch failed ${theme}/${mode}`)
  }
  try {
    if (!selectors) {
      const fixture = resolve(import.meta.dirname, "fixtures/tooltip-contrast.tsx").replaceAll("\\", "/")
      await cdp.evaluate(
        `(async()=>{const m=await import(${JSON.stringify("/@fs/" + fixture)});window.__disposeTooltipAudit=m.mount()})()`,
      )
      log("mounted real connection, model, server, file, shortcut and project tooltip components")
    }
    const targets =
      selectors ??
      Object.fromEntries(
        ["connection", "model", "server", "file", "keybind", "project"].map((name) => [name, `[data-audit="${name}"]`]),
      )
    for (const theme of selected)
      for (const mode of ["light", "dark"]) {
        await switchTheme(theme, mode)
        for (const [name, selector] of Object.entries(targets)) {
          await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 100 })
          await Bun.sleep(30)
          const box = await cdp.evaluate<{ x: number; y: number }>(
            `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing tooltip trigger');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
          )
          await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...box })
          let rows: ReturnType<typeof inspect> = []
          for (let i = 0; i < 65; i++) {
            await Bun.sleep(50)
            rows = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})()`)
            if (rows.length) break
          }
          if (!rows.length) throw new Error(`Tooltip did not open: ${theme}/${mode}/${name}`)
          if (!selectors) {
            const expected: Record<string, string> = {
              connection: "http://127.0.0.1:8090/v1/chat/completions",
              model: "Test Model",
              server: "1.0.0",
              file: "example.ts",
              keybind: "Ctrl+K",
              project: "cool money",
            }
            if (!rows.some((row) => row.text.includes(expected[name]))) {
              throw new Error(`Wrong tooltip captured: ${theme}/${mode}/${name}`)
            }
          }
          results.push({ theme, mode, target: name, rows })
          log(
            `${theme}/${mode}/${name} texts=${rows.length} min=${Math.min(...rows.map((row) => row.ratio)).toFixed(2)}`,
          )
          if (
            Bun.argv.includes("--screenshots") &&
            ["claude", "gruvbox", "solarized", "chatgpt"].includes(theme) &&
            ["connection", "project"].includes(name)
          ) {
            const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
            await Bun.write(`${output}/${theme}-${mode}-${name}.png`, Buffer.from(shot.data, "base64"))
          }
        }
      }
    const failures = results.flatMap((result) =>
      result.rows
        .filter((row) => row.ratio < 4.5)
        .map((row) => ({ theme: result.theme, mode: result.mode, target: result.target, ...row })),
    )
    await Bun.write(`${output}/results.json`, JSON.stringify({ results, failures }, null, 2))
    log(
      `completed variants=${selected.length * 2} tooltips=${results.length} texts=${results.reduce((n, r) => n + r.rows.length, 0)} failures=${failures.length} output=${output}`,
    )
    if (failures.length) throw new Error(`Found ${failures.length} unreadable tooltip texts`)
  } finally {
    if (!selectors) await cdp.evaluate(`window.__disposeTooltipAudit?.();delete window.__disposeTooltipAudit`)
    await switchTheme(original.theme, original.mode)
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 100 })
    await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: false })
    log(`restored ${original.theme}/${original.mode}`)
  }
})
