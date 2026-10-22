import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { DEFAULT_THEMES } from "../../ui/src/theme/default-themes"
import { withCdp } from "./cdp"

const output = resolve(Bun.env.THEME_AUDIT_OUTPUT ?? "/tmp/opencode-theme-contrast")
const log = (message: string) => console.log(`[theme-contrast] ${message}`)
const strict = Bun.argv.includes("--strict")
const settings = Bun.argv.includes("--settings")
const keybinds = Bun.argv.includes("--keybinds")
const controls = Bun.argv.includes("--controls")
const materials = Bun.argv.includes("--materials")
const selected = Bun.env.THEME_AUDIT_IDS?.split(",") ?? Object.keys(DEFAULT_THEMES).sort()

// Measure the rendered colors, including transparent backgrounds and inherited opacity.
function inspect() {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const context = canvas.getContext("2d", { willReadFrequently: true })!
  const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data].map((v, i) => v / (i === 3 ? 255 : 1))
  }
  const over = (fg: number[], bg: number[]) => [...fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3])), 1]
  const luminance = (color: number[]) =>
    color.slice(0, 3).reduce((sum, v, i) => {
      const n = v / 255
      return sum + [0.2126, 0.7152, 0.0722][i] * (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
    }, 0)
  const contrast = (a: number[], b: number[]) => {
    const x = luminance(a)
    const y = luminance(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth)
      return false
    for (let p: Element | null = el; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.display === "none" || s.visibility === "hidden" || +s.opacity < 0.01) return false
    }
    const hit = document.elementFromPoint(
      Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)),
      Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2)),
    )
    return (
      !!hit &&
      (el.contains(hit) ||
        hit.contains(el) ||
        !!el.closest("button")?.contains(hit) ||
        !!el.closest('[role="tooltip"], [data-component="project-rail-label"], [data-slot="prompt-placeholder"]'))
    )
  }
  const measure = (el: Element, kind: string, label: string, color = getComputedStyle(el).color) => {
    const layers: string[] = []
    let opacity = 1
    let gradient = false
    for (let p: Element | null = el; p; p = p.parentElement) {
      const s = getComputedStyle(p)
      opacity *= +s.opacity
      layers.unshift(s.backgroundColor)
      if (s.backgroundImage !== "none") gradient = true
    }
    const bg = layers.reduce((bg, color) => over(rgba(color), bg), [255, 255, 255, 1])
    const fg = rgba(color)
    fg[3] *= opacity
    const ratio = contrast(over(fg, bg), bg)
    const s = getComputedStyle(el)
    const threshold =
      kind === "icon" || parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700)
        ? 3
        : 4.5
    return {
      kind,
      label: label.slice(0, 100),
      ratio: +ratio.toFixed(3),
      threshold,
      fg: color,
      bg: bg.slice(0, 3).map(Math.round),
      opacity,
      gradient,
      component: el.closest("[data-component]")?.getAttribute("data-component"),
      class: el.getAttribute("class"),
    }
  }
  const icons = [
    ...document.querySelectorAll('button:not(:disabled):not([aria-disabled="true"]) [data-slot="icon-svg"]'),
  ]
    .filter(visible)
    .map((el) =>
      measure(
        el,
        "icon",
        el.closest("button")?.getAttribute("aria-label") ||
          el.closest("button")?.textContent?.trim() ||
          el.closest("button")?.getAttribute("data-icon") ||
          "icon",
      ),
    )
  const texts = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const label = node.textContent?.trim()
    const el = node.parentElement
    if (!el || !label || el.closest("script,style,svg,button:disabled,[aria-disabled=true]")) continue
    if (visible(el)) texts.push(measure(el, "text", label))
  }
  for (const el of document.querySelectorAll<HTMLInputElement>("input[placeholder],textarea[placeholder]")) {
    if (visible(el) && !el.value)
      texts.push(measure(el, "text", `placeholder:${el.placeholder}`, getComputedStyle(el, "::placeholder").color))
  }
  const tooltips = [
    ...document.querySelectorAll('[data-component="tooltip"][data-expanded], [data-component="project-rail-label"]'),
  ].map((el) => measure(el, "tooltip", el.textContent || ""))
  return { icons, texts, tooltips }
}

await mkdir(output, { recursive: true })
await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Refusing to audit outside the development renderer")
  const original = await cdp.evaluate<{ theme: string; scheme: string }>(
    `({theme:document.documentElement.dataset.theme,scheme:document.documentElement.dataset.colorScheme})`,
  )
  const results = []
  const switchMode = async (id: string, mode: string) => {
    await cdp.evaluate(`(() => {
      window.dispatchEvent(new StorageEvent('storage',{key:'opencode-color-scheme',newValue:${JSON.stringify(mode)}}));
      window.dispatchEvent(new StorageEvent('storage',{key:'opencode-theme-id',newValue:${JSON.stringify(id)}}));
    })()`)
    for (let i = 0; i < 100; i++) {
      if (
        await cdp.evaluate(
          `document.documentElement.dataset.theme===${JSON.stringify(id)}&&document.documentElement.dataset.colorScheme===${JSON.stringify(mode)}`,
        )
      )
        return
      await Bun.sleep(50)
    }
    throw new Error(`Theme switch timed out: ${id} ${mode}`)
  }
  const hover = async (selector: string) => {
    const box = await cdp.evaluate<{ x: number; y: number } | null>(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;
      const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`)
    if (!box) throw new Error(`Missing hover target ${selector}`)
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...box })
  }
  const screenshot = async (name: string) => {
    const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write(`${output}/${name}.png`, Buffer.from(shot.data, "base64"))
  }
  try {
    if (settings) {
      await cdp.evaluate(`document.querySelector('button[data-icon="settings-gear"]').click()`)
      for (let i = 0; i < 100; i++) {
        if (await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`)) break
        await Bun.sleep(50)
      }
    }
    for (const id of selected) {
      for (const mode of ["light", "dark"]) {
        await switchMode(id, mode)
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 600 })
        await Bun.sleep(180)
        if (controls || materials) {
          const page = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})()`)
          if (materials) {
            const collapsed = await cdp.evaluate(`(() => {
              const panel=document.querySelector('[data-component="sidebar-panel"]');
              return !!panel && panel.getBoundingClientRect().right<100;
            })()`)
            if (collapsed) {
              await cdp.evaluate(
                `document.querySelector('[data-action="project-switch"][aria-current="true"]').click()`,
              )
              try {
                await Bun.sleep(250)
                const sidebar = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})()`)
                page.icons.push(...sidebar.icons)
                page.texts.push(...sidebar.texts)
                await screenshot(`${id}-${mode}-sidebar-materials`)
              } finally {
                await cdp.evaluate(
                  `document.querySelector('[data-action="project-switch"][aria-current="true"]').click()`,
                )
                await Bun.sleep(250)
              }
            }
          }
          const failures = [...page.icons, ...page.texts].filter((item) => item.ratio < item.threshold)
          const layers = materials
            ? await cdp.evaluate(`(() => {
                const root=getComputedStyle(document.documentElement);
                const tokens=Object.fromEntries(['background-base','background-stronger','surface-raised-base','surface-inset-base','input-base','text-strong','text-base','text-weak','text-weaker'].map(k=>[k,root.getPropertyValue('--'+k).trim()]));
                const components=Object.fromEntries(['[data-slot="prompt-shell"]','[data-dock-surface="tray"]','.shiki','[data-component="sidebar-panel"]'].map(s=>{const el=document.querySelector(s);return [s,el?{background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderColor}:null]}));
                return {tokens,components};
              })()`)
            : undefined
          if (materials) await screenshot(`${id}-${mode}-materials`)
          results.push({ id, mode, ...page, layers, failures })
          await Bun.write(`${output}/results.json`, JSON.stringify(results, null, 2))
          log(
            `${id} ${mode} ${materials ? "materials" : "controls"} icons=${page.icons.length} texts=${page.texts.length} failures=${failures.length}${materials ? ` layers=${JSON.stringify(layers)}` : ""}`,
          )
          continue
        }
        if (keybinds) {
          await hover('[data-prompt-scope] button[data-component="button"]:not([data-action]):not([data-slot])')
          await Bun.sleep(900)
          const model = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})()`)
          await screenshot(`${id}-${mode}-model-keybind`)
          await hover('button[data-icon="settings-gear"]')
          await Bun.sleep(200)
          const rail = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})()`)
          await screenshot(`${id}-${mode}-rail-keybind`)
          const texts = [...model.texts, ...rail.texts].filter(
            (item) => item.component === "tooltip" || item.component === "project-rail-label",
          )
          const tooltips = [...model.tooltips, ...rail.tooltips]
          const failures = [...texts, ...tooltips].filter((item) => item.ratio < item.threshold)
          if (tooltips.length < 2 || texts.length < 3) throw new Error(`Missing keybind tooltip coverage ${id} ${mode}`)
          results.push({ id, mode, icons: [], texts, tooltips, failures })
          await Bun.write(`${output}/results.json`, JSON.stringify(results, null, 2))
          log(`${id} ${mode} keybinds texts=${texts.length} tooltips=${tooltips.length} failures=${failures.length}`)
          continue
        }
        if (settings) {
          const pages = []
          for (const fraction of [0, 0.24, 0.48, 0.72, 1]) {
            await cdp.evaluate(`new Promise(resolve => {
              const el=document.querySelector('[data-settings-general]');
              el.scrollTop=(el.scrollHeight-el.clientHeight)*${fraction};
              requestAnimationFrame(()=>requestAnimationFrame(resolve));
            })`)
            pages.push(await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})()`))
            if (fraction === 0.48) await screenshot(`${id}-${mode}-settings`)
          }
          const page = { icons: pages.flatMap((p) => p.icons), texts: pages.flatMap((p) => p.texts), tooltips: [] }
          const failures = [...page.icons, ...page.texts].filter((item) => item.ratio < item.threshold)
          results.push({ id, mode, ...page, failures })
          await Bun.write(`${output}/results.json`, JSON.stringify(results, null, 2))
          log(
            `${id} ${mode} settings icons=${page.icons.length} texts=${page.texts.length} failures=${failures.length}`,
          )
          continue
        }
        // Clicking the current project opens its real session list without navigating.
        await cdp.evaluate(`(() => {
          const panel=document.querySelector('[data-component="sidebar-panel"]');
          if(panel.getBoundingClientRect().right<100)document.querySelector('[data-action="project-switch"][aria-current="true"]').click();
        })()`)
        await Bun.sleep(180)
        const page = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})()`)
        await hover('[data-component="sidebar-panel"] button[data-icon="checklist"]')
        await Bun.sleep(800)
        const toolbar = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})()`)
        await screenshot(`${id}-${mode}-toolbar`)
        await hover('[data-action="project-switch"][aria-current="true"]')
        await Bun.sleep(120)
        // Rail labels arm on real pointer motion, not programmatic focus.
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 32, y: 150 })
        await hover('[data-action="project-switch"][aria-current="true"]')
        await Bun.sleep(200)
        const rail = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})()`)
        await screenshot(`${id}-${mode}-rail`)
        await cdp.evaluate(`document.querySelector('[data-action="project-switch"][aria-current="true"]').click()`)
        await Bun.sleep(180)
        await hover('[data-action="prompt-expand"]')
        await Bun.sleep(800)
        const prompt = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})()`)
        await screenshot(`${id}-${mode}-prompt`)
        const tooltips = [...toolbar.tooltips, ...rail.tooltips, ...prompt.tooltips]
        const unique = <T extends { label: string; kind: string; ratio: number }>(items: T[]) => {
          const values = new Map<string, T>()
          for (const item of items) {
            const key = item.kind + item.label
            const prior = values.get(key)
            if (!prior || item.ratio < prior.ratio) values.set(key, item)
          }
          return [...values.values()]
        }
        const icons = unique([...page.icons, ...toolbar.icons, ...prompt.icons])
        const texts = unique([...page.texts, ...toolbar.texts, ...prompt.texts])
        const failures = [...icons, ...texts, ...tooltips].filter((item) => item.ratio < item.threshold)
        results.push({ id, mode, icons, texts, tooltips, failures })
        await Bun.write(`${output}/results.json`, JSON.stringify(results, null, 2))
        await Bun.write(
          `${output}/failures.json`,
          JSON.stringify(
            results.flatMap((result) =>
              result.failures.map((item) => ({ theme: result.id, mode: result.mode, ...item })),
            ),
            null,
            2,
          ),
        )
        log(
          `${id} ${mode} icons=${icons.length} texts=${texts.length} tooltips=${tooltips.length} failures=${failures.length} minIcon=${Math.min(...icons.map((v) => v.ratio)).toFixed(2)} minTooltip=${Math.min(...tooltips.map((v) => v.ratio)).toFixed(2)}`,
        )
      }
    }
    await Bun.write(`${output}/results.json`, JSON.stringify(results, null, 2))
    const failures = results.flatMap((result) =>
      result.failures.map((item) => ({ theme: result.id, mode: result.mode, ...item })),
    )
    await Bun.write(`${output}/failures.json`, JSON.stringify(failures, null, 2))
    log(`completed variants=${results.length} failures=${failures.length} output=${output}`)
    if (
      strict &&
      (failures.length ||
        (!settings && !keybinds && !controls && !materials && results.some((result) => result.tooltips.length < 3)))
    ) {
      throw new Error(`Incomplete tooltip coverage or ${failures.length} contrast failures; see ${output}/results.json`)
    }
  } finally {
    if (settings) {
      await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" })
      await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" })
    }
    await switchMode(original.theme, original.scheme)
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 600 })
    log(`restored theme=${original.theme} mode=${original.scheme}`)
  }
})
