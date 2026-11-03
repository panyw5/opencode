import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { DEFAULT_THEMES } from "../../ui/src/theme/default-themes"
import { withCdp } from "./cdp"

const log = (message: string) => console.log(`[sidebar-session-themes] ${message}`)
const selector = '[data-component="sidebar-session"][data-active="true"]'

function inspect(hover: boolean) {
  const row = document.querySelector('[data-component="sidebar-session"][data-active="true"]')!
  const title = row.querySelector('[data-slot="session-title"]')!
  const probe = document.createElement("span")
  row.append(probe)
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!
  const color = (value: string) => {
    // Hover styles intentionally color all row spans; keep the measurement
    // probe independent of those foreground overrides.
    probe.style.setProperty("color", value, "important")
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = getComputedStyle(probe).color
    ctx.fillRect(0, 0, 1, 1)
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
  }
  const luminance = (rgb: number[]) =>
    rgb.reduce((n, value, i) => {
      const v = value / 255
      return n + [0.2126, 0.7152, 0.0722][i] * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    }, 0)
  const contrast = (a: number[], b: number[]) => {
    const x = luminance(a),
      y = luminance(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const style = getComputedStyle(row)
  const fills =
    style.backgroundImage === "none"
      ? [color(style.backgroundColor)]
      : [color("var(--sidebar-session-active-bg-top)"), color("var(--sidebar-session-active-bg-bottom)")]
  const ink = color(getComputedStyle(title).color)
  const meta = [...row.querySelectorAll('[data-slot="session-meta"] span')].map((el) =>
    color(getComputedStyle(el).color),
  )
  const result = {
    hover,
    background: style.backgroundImage === "none" ? style.backgroundColor : style.backgroundImage,
    foreground: getComputedStyle(title).color,
    title: Math.min(...fills.map((fill) => contrast(ink, fill))),
    meta: meta.length ? Math.min(...meta.flatMap((fg) => fills.map((fill) => contrast(fg, fill)))) : null,
  }
  probe.remove()
  return result
}

await withCdp(async (cdp, target) => {
  assert.ok(target.url.includes("localhost:5173"), "development renderer only")
  const original = await cdp.evaluate<{ theme: string; mode: string }>(
    `({theme:document.documentElement.dataset.theme,mode:document.documentElement.dataset.colorScheme})`,
  )
  assert.ok(
    await cdp.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
    "open a session whose sidebar entry is visible",
  )
  const switchTheme = async (id: string, mode: string) => {
    await cdp.evaluate(`(() => {
      window.dispatchEvent(new StorageEvent('storage',{key:'opencode-color-scheme',newValue:${JSON.stringify(mode)}}));
      window.dispatchEvent(new StorageEvent('storage',{key:'opencode-theme-id',newValue:${JSON.stringify(id)}}));
    })()`)
    for (let i = 0; i < 100; i++) {
      if (
        await cdp.evaluate(
          `document.documentElement.dataset.theme===${JSON.stringify(id)} && document.documentElement.dataset.colorScheme===${JSON.stringify(mode)}`,
        )
      )
        return
      await Bun.sleep(50)
    }
    throw new Error(`Theme switch timed out: ${id} ${mode}`)
  }
  await cdp.call("DOM.enable")
  await cdp.call("CSS.enable")
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 })
  const documentNode = await cdp.call<{ root: { nodeId: number } }>("DOM.getDocument")
  const row = await cdp.call<{ nodeId: number }>("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector })
  const failures: string[] = []
  const backgrounds = new Set<string>()
  try {
    for (const id of Object.keys(DEFAULT_THEMES)) {
      for (const mode of ["light", "dark"]) {
        await switchTheme(id, mode)
        for (const hover of [false, true]) {
          await cdp.call("CSS.forcePseudoState", { nodeId: row.nodeId, forcedPseudoClasses: hover ? ["hover"] : [] })
          await Bun.sleep(180)
          const colors = await cdp.evaluate<ReturnType<typeof inspect>>(`(${inspect.toString()})(${hover})`)
          backgrounds.add(colors.background)
          if (colors.title < 4.5 || (colors.meta !== null && colors.meta < 4.5)) {
            failures.push(
              `${id} ${mode} hover=${hover} title=${colors.title.toFixed(2)} meta=${colors.meta?.toFixed(2)} ${colors.background}`,
            )
          }
          log(
            `${id} ${mode} hover=${hover} title=${colors.title.toFixed(2)} meta=${colors.meta?.toFixed(2) ?? "none"} bg=${colors.background} fg=${colors.foreground}`,
          )
        }
      }
    }
    assert.ok(backgrounds.size > 30, `theme colors unexpectedly flattened: ${backgrounds.size}`)
    assert.deepEqual(failures, [], failures.join("\n"))
    log(
      `PASS ${Object.keys(DEFAULT_THEMES).length * 2} theme variants in resting/hover states; ${backgrounds.size} distinct native backgrounds`,
    )
  } finally {
    await cdp.call("CSS.forcePseudoState", { nodeId: row.nodeId, forcedPseudoClasses: [] })
    await switchTheme(original.theme, original.mode)
    log(`restored theme=${original.theme} mode=${original.mode}`)
  }

  const directory = await realpath(await mkdtemp("/tmp/opencode-sidebar-theme-"))
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const request = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(connection.url + path, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  let sessionID: string | undefined
  try {
    const session = await request("/session", "POST", { title: "QA sidebar theme colors" })
    sessionID = session.id
    const reply = await request(`/session/${sessionID}/shell`, "POST", {
      agent: "build",
      command: "printf SIDEBAR_THEME_SIDECAR_OK",
    })
    assert.ok(
      reply.parts.some((part: any) => part.type === "tool" && part.state.output?.includes("SIDEBAR_THEME_SIDECAR_OK")),
    )
    log("PASS sidecar message sent and completed reply received")
  } finally {
    if (sessionID) await request(`/session/${sessionID}`, "DELETE")
    await rm(directory, { recursive: true, force: true })
    log("removed owned sidecar test session")
  }
})
