import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { chromium, type Page } from "@playwright/test"
import { DEFAULT_THEMES } from "../../ui/src/theme/default-themes"
import { resolveThemeVariant } from "../../ui/src/theme/resolve"

// CSS-state regression, NOT Kobalte interaction coverage. Only :hover/:active
// use real input; highlighted/expanded/disabled are explicitly authored fixtures.
// Uses an isolated Chromium profile; never stops the user's app or browser.
//   bun packages/app/scripts/audit-menu-feedback-web.ts
// Optional: MENU_AUDIT_BASE_URL, THEME_AUDIT_IDS (subset, never a full-suite pass).
const root = fileURLToPath(new URL("../../..", import.meta.url))
const ids = Bun.env.THEME_AUDIT_IDS?.split(",").filter(Boolean) ?? Object.keys(DEFAULT_THEMES).sort()
if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !DEFAULT_THEMES[id])) {
  throw new Error("Empty, duplicate, or unknown THEME_AUDIT_IDS")
}
const log = (message: string) => console.info(`[menu-feedback] ${message}`)
const failures: string[] = []
let assertions = 0
let themes = 0
let surfaces = 0
let items = 0
let minContrast = Infinity
let minHover = Infinity
let minPressed = Infinity
const check = (ok: boolean, message: string) => {
  assertions++
  if (!ok) failures.push(message)
}
type RGBA = [number, number, number, number]
const distance = (a: RGBA, b: RGBA) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
const over = (fg: RGBA, bg: RGBA): RGBA => {
  const alpha = fg[3] + bg[3] * (1 - fg[3])
  if (!alpha) throw new Error("Cannot composite fully transparent colors")
  return [0, 1, 2].map((i) => (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / alpha).concat(alpha) as RGBA
}
const contrast = (a: RGBA, b: RGBA) => {
  const luminance = (c: RGBA) =>
    c
      .slice(0, 3)
      .map((v) => {
        const x = v / 255
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
      })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// Canvas resolves color-mix()/color(srgb ...) to actual sRGB RGBA bytes, including
// alpha. Regex-parsing color-mix is not valid. Finish actual CSS transitions so
// this audit checks final styles, not animation timing (no state CSS overrides).
async function read(page: Page, key: string) {
  return page.evaluate((key) => {
    const el = document.querySelector<HTMLElement>(`[data-audit-key="${key}"]`)
    if (!el) throw new Error(`Missing fixture ${key}`)
    const panel = el.closest<HTMLElement>("[data-audit-panel]")!
    getComputedStyle(el).backgroundColor
    for (const target of [panel, el]) for (const animation of target.getAnimations()) animation.finish()
    const style = getComputedStyle(el)
    const panelStyle = getComputedStyle(panel)
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!
    const rgba = (value: string) => {
      if (!CSS.supports("color", value)) throw new Error(`Invalid computed color ${value}`)
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = value
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255] as RGBA
    }
    const rect = el.getBoundingClientRect()
    const label = el.querySelector<HTMLElement>('[data-slot$="-item-label"]')
    const color = getComputedStyle(label ?? el).color
    return {
      background: rgba(style.backgroundColor),
      color: rgba(color),
      panel: rgba(panelStyle.backgroundColor),
      panelRaw: panelStyle.backgroundColor,
      filter: panelStyle.backdropFilter,
      pointerEvents: style.pointerEvents,
      hover: el.matches(":hover"),
      active: el.matches(":active"),
      feedback: [
        style.backgroundColor,
        style.boxShadow,
        style.outlineStyle,
        style.outlineWidth,
        style.borderStyle,
        style.borderWidth,
      ].join("|"),
      signature: [style.backgroundColor, color, style.boxShadow, style.outline, style.borderColor].join("|"),
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      width: rect.width,
      height: rect.height,
    }
  }, key)
}

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 800 } })
  page.on("pageerror", (error) => failures.push(`pageerror ${error.message}`))
  await page.goto(Bun.env.MENU_AUDIT_BASE_URL ?? "http://127.0.0.1:4467", { waitUntil: "domcontentloaded" })
  const sourceCSS = join(root, "packages/app/src/index.css")
  await page.waitForFunction(
    (sourceCSS) =>
      [...document.querySelectorAll("style[data-vite-dev-id]")].some(
        (el) => el.getAttribute("data-vite-dev-id") === sourceCSS,
      ),
    sourceCSS,
    { timeout: 30_000 },
  )
  log(`verified Vite source=${sourceCSS}`)
  await page.waitForFunction(() => !!document.getElementById("oc-theme")?.textContent, undefined, { timeout: 30_000 })
  const desktopCSS = await Bun.file(join(root, "packages/desktop/src/renderer/popup-surfaces.css")).text()
  if (!desktopCSS.trim()) throw new Error("Missing real desktop popup-surfaces.css")
  const desktopStyle = await page.addStyleTag({ content: desktopCSS })
  const keys = await page.evaluate(() => {
    const host = document.createElement("section")
    host.id = "menu-feedback-css-fixture"
    host.setAttribute("aria-label", "CSS fixture; marked states are not Kobalte interaction validation")
    host.style.cssText =
      "position:fixed;left:24px;top:24px;width:1280px;z-index:2147483647;display:grid;grid-template-columns:repeat(4,1fr);gap:12px"
    const note = document.createElement("div")
    note.textContent =
      "CSS fixture: highlighted / expanded / disabled are authored markers, NOT Kobalte behavior. Hover / pressed: real mouse."
    note.style.cssText = "grid-column:1/-1;color:var(--text-strong);font:12px sans-serif"
    host.append(note)
    const keys: string[] = []
    for (const family of ["context-menu", "dropdown-menu"]) {
      for (const kind of ["content", "sub-content"]) {
        const column = document.createElement("div")
        const title = document.createElement("div")
        title.textContent = `${family}-${kind}`
        title.style.cssText = "color:var(--text-strong);font:12px sans-serif;margin-bottom:8px"
        const panel = document.createElement("div")
        panel.dataset.component = `${family}-${kind}`
        panel.dataset.auditPanel = ""
        panel.dataset.expanded = "" // fixture-only: keep real content CSS open
        for (const type of ["item", "checkbox-item", "radio-item", "sub-trigger"]) {
          const item = document.createElement("div")
          const key = `${family}-${kind}-${type}`
          item.dataset.slot = `${family}-${type}`
          item.dataset.auditKey = key
          item.dataset.fixtureOnlyStates = "highlighted expanded disabled"
          item.tabIndex = -1
          item.setAttribute(
            "role",
            type === "checkbox-item" ? "menuitemcheckbox" : type === "radio-item" ? "menuitemradio" : "menuitem",
          )
          const label = document.createElement("span")
          label.dataset.slot = `${family}-item-label`
          label.textContent = type
          item.append(label)
          panel.append(item)
          keys.push(key)
        }
        column.append(title, panel)
        host.append(column)
      }
    }
    document.body.append(host)
    return keys
  })
  if (keys.length !== 16) throw new Error(`Missing fixture inventory: ${keys.length}/16`)
  const panelKeys = keys.filter((key) => key.endsWith("-content-item"))
  if (panelKeys.length !== 4) throw new Error(`Missing panels: ${panelKeys.length}/4`)

  log(
    "scope: all menu CSS states on actual opaque desktop panels; Windows + web: actual panel color/filter only, not dynamic frosted-backdrop contrast or Kobalte behavior",
  )
  for (const id of ids)
    for (const mode of ["light", "dark"] as const) {
      const expected = resolveThemeVariant(DEFAULT_THEMES[id][mode], mode === "dark")
      const tokens = {
        "text-strong": expected["text-strong"],
        "surface-raised-stronger-non-alpha": expected["surface-raised-stronger-non-alpha"],
      }
      await page.evaluate(
        ({ id, mode }) => {
          for (const [key, value] of [
            ["opencode-theme-id", id],
            ["opencode-color-scheme", mode],
          ]) {
            localStorage.setItem(key, value)
            window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }))
          }
        },
        { id, mode },
      )
      // Verify both emitted #oc-theme rules AND effective tokens, never just dataset.
      try {
        await page.waitForFunction(
          ({ id, mode, tokens }) => {
            const root = document.documentElement
            const style = document.getElementById("oc-theme") as HTMLStyleElement | null
            const rule = style?.sheet?.cssRules[0] as CSSStyleRule | undefined
            const computed = getComputedStyle(root)
            const normalize = (value: string) => value.replace(/\s/g, "").toLowerCase()
            return (
              root.dataset.theme === id &&
              root.dataset.colorScheme === mode &&
              computed.colorScheme === mode &&
              !!rule &&
              Object.entries(tokens).every(
                ([name, value]) =>
                  normalize(rule.style.getPropertyValue(`--${name}`)) === normalize(value) &&
                  normalize(computed.getPropertyValue(`--${name}`)) === normalize(value),
              )
            )
          },
          { id, mode, tokens },
          { timeout: 10_000 },
        )
      } catch (error) {
        const actual = await page.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          scheme: document.documentElement.dataset.colorScheme,
          css: document.getElementById("oc-theme")?.textContent,
          strong: getComputedStyle(document.documentElement).getPropertyValue("--text-strong"),
          raised: getComputedStyle(document.documentElement).getPropertyValue("--surface-raised-stronger-non-alpha"),
        }))
        throw new Error(
          `Theme tokens did not apply ${id}/${mode}; expected=${JSON.stringify(tokens)} actual=${JSON.stringify(actual)}`,
          { cause: error },
        )
      }
      themes++
      const tag = `${id}/${mode}`
      let raised: RGBA | undefined
      for (const scope of ["web", "windows", "desktop"] as const) {
        await desktopStyle.evaluate((el, enabled) => {
          ;(el as HTMLStyleElement).disabled = !enabled
        }, scope !== "web")
        await page.evaluate((scope) => {
          document.documentElement.dataset.platform = scope === "web" ? "web" : "desktop"
          document.documentElement.dataset.os = scope === "windows" ? "windows" : "macos"
        }, scope)
        for (const key of panelKeys) {
          const state = await read(page, key)
          surfaces++
          check(state.width > 0 && state.height > 0, `${tag}/${scope}/${key} zero-sized fixture`)
          if (scope === "desktop") {
            check(
              state.panel[3] === 1 && state.filter === "none",
              `${tag}/${scope}/${key} expected opaque unfiltered panel: ${state.panelRaw}/${state.filter}`,
            )
            raised ??= state.panel
            check(distance(state.panel, raised) <= 1, `${tag}/${scope}/${key} inconsistent raised panel`)
          } else if (scope === "windows") {
            check(
              state.panel[3] === 1 && state.filter === "none",
              `${tag}/${scope}/${key} expected real desktop CSS opaque Windows panel: ${state.panelRaw}/${state.filter}`,
            )
            raised ??= state.panel
            check(distance(state.panel, raised) <= 1, `${tag}/${scope}/${key} inconsistent raised panel`)
          } else {
            check(
              state.panel[3] > 0 && state.panel[3] < 1 && state.filter.includes("blur("),
              `${tag}/${scope}/${key} expected actual translucent frosted web panel: ${state.panelRaw}/${state.filter}`,
            )
          }
        }
      }
      // Confirm the desktop panel really uses the resolver's raised token.
      const expectedRaised = await page.evaluate((color) => {
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 1
        const ctx = canvas.getContext("2d")!
        ctx.fillStyle = color
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
        return [r, g, b, a / 255] as RGBA
      }, tokens["surface-raised-stronger-non-alpha"])
      check(
        !!raised && distance(raised, expectedRaised) <= 1,
        `${tag} actual desktop background differs from resolved raised token`,
      )

      for (const key of keys) {
        const label = `${tag}/${key}`
        await page.mouse.move(0, 0)
        const rest = await read(page, key)
        await page.mouse.move(rest.x, rest.y)
        const hover = await read(page, key)
        await page.mouse.down()
        let pressed: Awaited<ReturnType<typeof read>>
        try {
          pressed = await read(page, key)
        } finally {
          await page.mouse.up()
        }
        await page.mouse.move(0, 0)
        const item = page.locator(`[data-audit-key="${key}"]`)
        await item.evaluate((el) => el.setAttribute("data-highlighted", ""))
        const keyboard = await read(page, key)
        await item.evaluate((el) => el.removeAttribute("data-highlighted"))
        items++
        const restBG = over(rest.background, rest.panel)
        const hoverBG = over(hover.background, hover.panel)
        const pressedBG = over(pressed.background, pressed.panel)
        const hoverDelta = contrast(restBG, hoverBG)
        const pressedDelta = contrast(hoverBG, pressedBG)
        minHover = Math.min(minHover, hoverDelta)
        minPressed = Math.min(minPressed, pressedDelta)
        check(hover.hover && pressed.active, `${label} missing real :hover/:active input states`)
        check(hoverDelta >= 1.05, `${label} hover indistinct: ${hoverDelta.toFixed(4)}`)
        check(pressedDelta >= 1.03, `${label} pressed indistinct: ${pressedDelta.toFixed(4)}`)
        check(keyboard.signature === hover.signature, `${label} authored highlighted style differs from real hover`)
        for (const [name, state] of Object.entries({ rest, hover, pressed, keyboard })) {
          const background = over(state.background, state.panel)
          const ratio = contrast(over(state.color, background), background)
          minContrast = Math.min(minContrast, ratio)
          check(ratio >= 4.5, `${label}/${name} normal-text contrast ${ratio.toFixed(4)} < 4.5`)
        }
        await item.evaluate((el) => el.setAttribute("data-expanded", ""))
        const expanded = await read(page, key)
        check(expanded.signature === hover.signature, `${label} authored expanded style differs from hover`)
        await item.evaluate((el) => {
          el.setAttribute("data-disabled", "")
          el.setAttribute("data-highlighted", "")
        })
        const disabled = await read(page, key)
        await page.mouse.move(rest.x, rest.y)
        await page.mouse.down()
        try {
          const disabledPressed = await read(page, key)
          check(
            disabled.pointerEvents === "none" &&
              disabled.feedback === rest.feedback &&
              disabledPressed.signature === disabled.signature &&
              !disabledPressed.active,
            `${label} disabled fixture accepts input or renders highlight`,
          )
        } finally {
          await page.mouse.up()
        }
        await item.evaluate((el) => {
          el.removeAttribute("data-disabled")
          el.removeAttribute("data-highlighted")
          el.removeAttribute("data-expanded")
        })
      }
      await page.mouse.move(0, 0)
      if (id === "claude" || id === "arc") {
        const file = `/tmp/menu-feedback-${id}-${mode}.png`
        await page.locator("#menu-feedback-css-fixture").screenshot({ path: file })
        log(`screenshot=${file} (desktop CSS fixture, not Kobalte menu)`)
      }
      log(
        `${tag} theme tokens matched text-strong=${tokens["text-strong"]} raised=${tokens["surface-raised-stronger-non-alpha"]}; surfaces=12 desktop-item-cases=16 cumulative-failures=${failures.length}`,
      )
    }
  check(themes === ids.length * 2 && themes > 0, `Missing theme cases ${themes}/${ids.length * 2}`)
  check(surfaces === themes * 12 && surfaces > 0, `Missing surface cases ${surfaces}/${themes * 12}`)
  check(items === themes * 16 && items > 0, `Missing item cases ${items}/${themes * 16}`)
  for (const failure of failures) console.error(`[menu-feedback] FAIL ${failure}`)
  log(
    `SUMMARY ${ids.length === Object.keys(DEFAULT_THEMES).length ? "full-suite" : "SUBSET"} themes=${themes} surface-cases=${surfaces} item-cases=${items} assertions=${assertions} failures=${failures.length} min-text-contrast=${minContrast.toFixed(3)} min-hover=${minHover.toFixed(3)} min-pressed=${minPressed.toFixed(3)}`,
  )
  if (failures.length) throw new Error(`${failures.length} menu CSS regression failures`)
  log("PASS (CSS-state fixture only; no claim about real Kobalte keyboard/menu behavior or native desktop rendering)")
} finally {
  await browser.close()
}
