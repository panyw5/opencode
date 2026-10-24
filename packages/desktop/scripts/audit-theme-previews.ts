import { mkdir } from "node:fs/promises"
import { rgbToHex } from "../../ui/src/theme/color"
import { contrastRatio } from "../../ui/src/theme/contrast"
import { DEFAULT_THEMES } from "../../ui/src/theme/default-themes"
import { themePreview } from "../../app/src/components/theme-preview"
import { themeOptionIDs, themeOptionName } from "../../app/src/components/theme-options"
import { withCdp } from "./cdp"

const output = "/tmp/opencode-theme-previews"
const log = (message: string) => console.info(`[theme-preview-audit] ${message}`)

function inspect(id: string) {
  const card = document.querySelector<HTMLElement>(`[data-component="settings-theme-card"][data-theme-id="${id}"]`)!
  const preview = card.querySelector<HTMLElement>(".theme-card-preview")!
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const context = canvas.getContext("2d", { willReadFrequently: true })!
  const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data]
  }
  const over = (fg: number[], bg: number[]) =>
    fg.slice(0, 3).map((v, i) => (v * fg[3]) / 255 + bg[i] * (1 - fg[3] / 255))
  const samples = [
    ...card.querySelectorAll(
      "[data-code],.theme-card-tab,.theme-card-project,.theme-card-send,.theme-card-caption>span,[data-preview-surface=popup]",
    ),
  ].map((el) => {
    const layers = []
    for (let p: Element | null = el; p; p = p.parentElement) layers.unshift(rgba(getComputedStyle(p).backgroundColor))
    const bg = layers.reduce((bg, fg) => over(fg, bg), [255, 255, 255])
    return {
      kind: (el as HTMLElement).dataset.code ?? el.className,
      bg,
      fg: over(rgba(getComputedStyle(el).color), bg),
    }
  })
  const box = card.getBoundingClientRect()
  const code = card.querySelector<HTMLElement>(".theme-card-code")!
  const root = getComputedStyle(preview)
  return {
    name: card.getAttribute("aria-label"),
    tokens: Object.fromEntries([...preview.style].map((key) => [key, root.getPropertyValue(key).trim()])),
    samples,
    overflow: code.scrollWidth > code.clientWidth + 1,
    tabBorder: getComputedStyle(card.querySelector(".theme-card-tab")!).borderBottomWidth,
    projectBorder: getComputedStyle(card.querySelector(".theme-card-project")!).borderLeftWidth,
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    columns: getComputedStyle(card.parentElement!).gridTemplateColumns.split(" ").length,
  }
}

await mkdir(output, { recursive: true })
await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Only test the development renderer")
  const original = await cdp.evaluate<{ id: string; mode: string }>(
    `({id:document.documentElement.dataset.theme,mode:document.documentElement.dataset.colorScheme})`,
  )
  const switchTheme = async (id: string, mode: string) => {
    await cdp.evaluate(
      `window.dispatchEvent(new StorageEvent('storage',{key:'opencode-color-scheme',newValue:${JSON.stringify(mode)}}));window.dispatchEvent(new StorageEvent('storage',{key:'opencode-theme-id',newValue:${JSON.stringify(id)}}));`,
    )
    for (let i = 0; i < 100; i++) {
      if (
        await cdp.evaluate(
          `document.documentElement.dataset.theme===${JSON.stringify(id)}&&document.documentElement.dataset.colorScheme===${JSON.stringify(mode)}`,
        )
      ) {
        await Bun.sleep(250)
        return
      }
      await Bun.sleep(50)
    }
    throw new Error(`Theme switch timed out ${id} ${mode}`)
  }
  const screenshot = async (name: string, box: { x: number; y: number; width: number; height: number }) => {
    const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      clip: { ...box, scale: 1 },
    })
    await Bun.write(`${output}/${name}.png`, Buffer.from(shot.data, "base64"))
  }
  const hex = (color: number[]) => rgbToHex(color[0] / 255, color[1] / 255, color[2] / 255)
  const results = []
  try {
    if (!(await cdp.evaluate(`!!document.querySelector('[data-settings-appearance]')`)))
      throw new Error("Open Appearance settings before auditing")
    for (const mode of ["light", "dark"] as const) {
      await switchTheme(original.id, mode)
      const ids = themeOptionIDs(Object.keys(DEFAULT_THEMES).sort(), mode)
      const count = await cdp.evaluate<number>(
        `document.querySelectorAll('[data-component="settings-theme-card"]').length`,
      )
      if (count !== ids.length) throw new Error(`Wrong ${mode} card count ${count} expected ${ids.length}`)
      for (const id of ids) {
        await cdp.evaluate(
          `document.querySelector('[data-component="settings-theme-card"][data-theme-id="${id}"]').scrollIntoView({block:'center'})`,
        )
        await cdp.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
        await Bun.sleep(150)
        const card = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})(${JSON.stringify(id)})`)
        const expected = themePreview(DEFAULT_THEMES[id], mode)
        const failures = Object.entries(expected)
          .filter(([key, value]) => card.tokens[key] !== value)
          .map(([key]) => `wrong token ${key}`)
        if (card.name !== themeOptionName(id, DEFAULT_THEMES[id].name, mode)) failures.push("wrong flavor label")
        if (card.overflow) failures.push("code sample overflows")
        if (card.tabBorder !== "0px" || card.projectBorder !== "0px") failures.push("unexpected accent border")
        const samples = card.samples.map((s) => ({ ...s, ratio: contrastRatio(hex(s.fg), hex(s.bg)) }))
        for (const sample of samples)
          if (sample.ratio < 4.5) failures.push(`${sample.kind} contrast=${sample.ratio.toFixed(2)}`)
        results.push({ id, mode, columns: card.columns, samples, failures })
        await screenshot(`${id}-${mode}`, card.box)
        log(`${id} ${mode} samples=${samples.length} failures=${failures.join(",") || 0}`)
      }
    }
    await switchTheme("catppuccin-frappe", "dark")
    await switchTheme("catppuccin-frappe", "light")
    await cdp.evaluate(
      `document.querySelector('[data-component="settings-theme-card"][data-theme-id="catppuccin"]').click()`,
    )
    if (
      !(await cdp.evaluate(
        `document.documentElement.dataset.theme==='catppuccin-frappe'&&document.querySelector('[data-theme-id="catppuccin"]').getAttribute('aria-pressed')==='true'`,
      ))
    )
      throw new Error("Latte lost preferred dark flavor")
    await switchTheme("catppuccin-frappe", "dark")
    if (
      !(await cdp.evaluate(
        `document.querySelector('[data-theme-id="catppuccin-frappe"]').getAttribute('aria-pressed')==='true'`,
      ))
    )
      throw new Error("Frappe not restored")
    log("Latte selection preserves preferred Frappe verified")

    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await switchTheme("catppuccin", "light")
    await cdp.evaluate(`document.querySelector('[data-theme-id="catppuccin"]').scrollIntoView({block:'center'})`)
    await Bun.sleep(150)
    const narrow = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})('catppuccin')`)
    if (narrow.overflow || narrow.box.x < 0 || narrow.box.x + narrow.box.width > 391)
      throw new Error(`Narrow layout overflow ${JSON.stringify(narrow.box)}`)
    await screenshot("latte-narrow", narrow.box)
    log(`narrow width=390 columns=${narrow.columns} codeOverflow=${narrow.overflow}`)
    await Bun.write(`${output}/results.json`, JSON.stringify(results, null, 2))
    const failures = results.flatMap((r) => r.failures.map((f) => `${r.id} ${r.mode} ${f}`))
    log(`completed cards=${results.length} failures=${failures.length} output=${output}`)
    if (failures.length) throw new Error(failures.join("\n"))
  } finally {
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    await switchTheme(original.id, original.mode)
    log(`restored theme=${original.id} mode=${original.mode}`)
  }
})
