import { appendFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserWindow, screen, session, WebContentsView } from "electron"
import { write as writeLog } from "./logging"

// P0 spike for the embedded browser feature (.tasks/browser-tools/prd.md Phase 0).
// Throwaway code, enabled only with OPENCODE_BROWSER_SPIKE=1. Validates:
//  P0-D-01: WebContentsView embedding / bounds / visibility
//  P0-D-02: webContents.debugger CDP (navigate / screenshot / AX tree / input)
// Results are written to /tmp/opencode-spike-summary.json and logged under the
// "browser" domain.

const SPIKE_PARTITION = "spike-browse"

type SpikeStep = {
  step: string
  ok: boolean
  detail?: Record<string, unknown>
  error?: string
  startedAt: number
  durationMs?: number
}

const steps: SpikeStep[] = []

function log(step: string, message: string, extra?: Record<string, unknown>) {
  writeLog("browser", `spike ${step}: ${message}`, extra)
}

async function runStep(step: string, fn: () => Promise<Record<string, unknown> | void>) {
  const startedAt = Date.now()
  log(step, "start")
  try {
    const detail = (await fn()) ?? {}
    const entry: SpikeStep = {
      step,
      ok: true,
      detail,
      startedAt,
      durationMs: Date.now() - startedAt,
    }
    steps.push(entry)
    log(step, "ok", { durationMs: entry.durationMs, ...detail })
  } catch (error) {
    const entry: SpikeStep = {
      step,
      ok: false,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      startedAt,
      durationMs: Date.now() - startedAt,
    }
    steps.push(entry)
    log(step, "FAILED", { error: entry.error, durationMs: entry.durationMs })
  }
}

function spikeDir() {
  const dir = join(tmpdir(), "opencode-browser-spike")
  mkdirSync(dir, { recursive: true })
  return dir
}

export function startBrowserSpike(win: BrowserWindow) {
  if (process.env.OPENCODE_BROWSER_SPIKE !== "1") return

  log("boot", "starting browser spike", { windowId: win.id })

  const inMemorySession = session.fromPartition(SPIKE_PARTITION)
  const view = new WebContentsView({
    webPreferences: {
      partition: SPIKE_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  // --- bounds management (main-computed for the spike; renderer ResizeObserver lands in P1) ---
  const rightHalf = () => {
    const { width, height } = win.getContentBounds()
    // account for macOS hidden titlebar height ~ keep bottom area simple
    return { x: Math.floor(width / 2), y: 0, width: Math.floor(width / 2), height }
  }
  const applyBounds = () => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return
    const bounds = rightHalf()
    view.setBounds(bounds)
    log("bounds", "applied", { ...bounds })
  }
  win.on("resize", applyBounds)
  win.on("move", applyBounds)

  win.contentView.addChildView(view)
  applyBounds()

  // --- input-mapping probe (OPENCODE_SPIKE_PROBE=1) ---
  // Pairs the real OS cursor position with the coordinates Chromium reports for
  // mouse events on the view, to quantify the click-offset bug reported on the
  // embedded browser panel. Writes JSONL to <tmp>/opencode-browser-spike/probe-pairs.jsonl.
  if (process.env.OPENCODE_SPIKE_PROBE === "1") {
    const pairsFile = join(spikeDir(), "probe-pairs.jsonl")
    const lastInput = { x: NaN, y: NaN, type: "", at: 0 }
    view.webContents.on(
      "input-event" as never,
      (_e: unknown, input: { type: string; x: number; y: number }) => {
        // Electron input-event type is "mouseMove" (CDP calls it mouseMoved)
        if (["mouseMove", "mouseMoved", "mouseDown", "mouseUp"].includes(input.type)) {
          lastInput.x = input.x
          lastInput.y = input.y
          lastInput.type = input.type
          lastInput.at = Date.now()
        }
      },
    )
    const probeTimer = setInterval(() => {
      if (win.isDestroyed() || view.webContents.isDestroyed()) {
        clearInterval(probeTimer)
        return
      }
      const cursor = screen.getCursorScreenPoint()
      const wb = win.getContentBounds()
      const b = view.getBounds()
      const rel = { x: cursor.x - wb.x - b.x, y: cursor.y - wb.y - b.y }
      const inside = rel.x >= 0 && rel.y >= 0 && rel.x < b.width && rel.y < b.height
      const fresh = Date.now() - lastInput.at < 300
      if (inside && fresh) {
        appendFileSync(
          pairsFile,
          JSON.stringify({
            t: Date.now(),
            cursor,
            rel,
            input: { x: lastInput.x, y: lastInput.y, type: lastInput.type },
            err: { x: lastInput.x - rel.x, y: lastInput.y - rel.y },
          }) + "\n",
        )
      }
    }, 120)
  }

  view.webContents.on("did-navigate", (_e, url) => log("nav", "did-navigate", { url }))
  view.webContents.on("did-fail-load", (_e, code, desc, url, isMain) =>
    log("nav", "did-fail-load", { code, desc, url, isMain }, ),
  )
  view.webContents.on("render-process-gone", (_e, details) => log("nav", "render-process-gone", { ...details }))
  view.webContents.setWindowOpenHandler((details) => {
    log("nav", "window-open denied", { url: details.url })
    return { action: "deny" }
  })

  const waitForLoad = (url: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`load timeout: ${url}`)), 20_000)
      const onLoad = (_e: Electron.Event, loaded: string) => {
        if (loaded !== url) return
        cleanup()
        resolve()
      }
      const onFail = (_e: Electron.Event, code: number, desc: string, failed: string, isMain: boolean) => {
        if (!isMain) return
        cleanup()
        reject(new Error(`did-fail-load ${code} ${desc}: ${failed}`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        view.webContents.off("did-navigate", onLoad)
        view.webContents.off("did-fail-load", onFail)
      }
      view.webContents.on("did-navigate", onLoad)
      view.webContents.on("did-fail-load", onFail)
      void view.webContents.loadURL(url).catch(reject)
    })

  const screenshot = async (name: string): Promise<string> => {
    const img = (await view.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png" })) as {
      data: string
    }
    const file = join(spikeDir(), name)
    writeFileSync(file, Buffer.from(img.data, "base64"))
    return file
  }

  const runCdpProbe = async (label: string) => {
    const dbg = view.webContents.debugger
    await dbg.sendCommand("Page.enable")
    await dbg.sendCommand("Runtime.enable")
    await dbg.sendCommand("Accessibility.enable")
    // give the AX tree a moment to materialize after Accessibility.enable
    await new Promise((r) => setTimeout(r, 1200))

    // Screenshot
    const shotFile = await screenshot(`${label}-shot.png`)

    // Accessibility tree
    const ax = (await dbg.sendCommand("Accessibility.getFullAXTree", {})) as {
      nodes: Array<{ nodeId: string; role?: { value: string }; name?: { value: string } }>
    }
    const axSummary = {
      nodeCount: ax.nodes.length,
      roles: [...new Set(ax.nodes.map((n) => n.role?.value ?? "?"))].slice(0, 40),
      interactiveSample: ax.nodes
        .filter((n) => ["button", "link", "textbox", "checkbox"].includes(n.role?.value ?? ""))
        .slice(0, 15)
        .map((n) => `${n.role?.value}:${(n.name?.value ?? "").slice(0, 40)}`),
    }
    writeFileSync(join(spikeDir(), `${label}-ax.json`), JSON.stringify(ax.nodes.slice(0, 200), null, 2))

    return { shotFile, axSummary }
  }

  const clickFirstLinkViaCdp = async (): Promise<string> => {
    const dbg = view.webContents.debugger
    const rect = (await dbg.sendCommand("Runtime.evaluate", {
      expression: `(() => { const a = document.querySelector("a"); const r = a.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, href: a.href }) })()`,
      returnByValue: true,
    })) as { result: { value: string } }
    const { x, y, href } = JSON.parse(rect.result.value)
    log("click", "dispatching mouse events", { x, y, href })
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" })
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await dbg.sendCommand("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0,
      })
    }
    return href
  }

  void (async () => {
    await runStep("create-view", async () => {
      return {
        partition: SPIKE_PARTITION,
        isTransient: !SPIKE_PARTITION.startsWith("persist:"),
        viewId: view.webContents.id,
      }
    })

    await runStep("load-example-com", async () => {
      const started = Date.now()
      await waitForLoad("https://example.com/")
      return { loadMs: Date.now() - started, url: view.webContents.getURL(), title: view.webContents.getTitle() }
    })

    await runStep("debugger-attach", async () => {
      const dbg = view.webContents.debugger
      dbg.on("attach" as never, (_e: unknown, version: string) => log("debugger", "attached", { version }))
      dbg.on("detach", (_e, reason) => log("debugger", "detached", { reason }))
      dbg.attach("1.3")
      return { attached: dbg.isAttached() }
    })

    let exampleProbe: Awaited<ReturnType<typeof runCdpProbe>> | undefined
    await runStep("cdp-probe-example-com", async () => {
      exampleProbe = await runCdpProbe("example")
      return { shotFile: exampleProbe.shotFile, ...exampleProbe.axSummary }
    })

    await runStep("cdp-click-first-link", async () => {
      // retry: click dispatch is occasionally flaky (see run 1 vs 2); re-resolve the
      // rect each attempt and dispatch a move+press+release sequence.
      const deadline = Date.now() + 30_000
      let lastHref = ""
      for (let attempt = 1; attempt <= 3 && Date.now() < deadline; attempt++) {
        lastHref = await clickFirstLinkViaCdp()
        const waitUntil = Date.now() + 8_000
        while (Date.now() < waitUntil) {
          const url = view.webContents.getURL()
          if (url.includes("iana.org")) return { href: lastHref, navigatedTo: url, attempt }
          await new Promise((r) => setTimeout(r, 200))
        }
        log("click", `attempt ${attempt} did not navigate`, { url: view.webContents.getURL() })
      }
      throw new Error(`navigation after click did not reach iana.org, url=${view.webContents.getURL()}`)
    })

    await runStep("debugger-vs-devtools", async () => {
      // Validate the documented mutual exclusion: DevTools cannot open while debugger attached.
      const dbg = view.webContents.debugger
      let devtoolsError = "no error"
      try {
        view.webContents.openDevTools({ mode: "detach" })
        await new Promise((r) => setTimeout(r, 1000))
      } catch (error) {
        devtoolsError = error instanceof Error ? error.message : String(error)
      }
      // Can our debugger still issue commands while DevTools is attached?
      let cdpWhileDevtools = "n/a"
      try {
        const evalRes = (await dbg.sendCommand("Runtime.evaluate", {
          expression: "1+1",
          returnByValue: true,
        })) as { result: { value: number } }
        cdpWhileDevtools = `ok:${evalRes.result.value}`
      } catch (error) {
        cdpWhileDevtools = `failed:${error instanceof Error ? error.message : String(error)}`
      } finally {
        const opened = view.webContents.isDevToolsOpened()
        view.webContents.closeDevTools()
        return { devtoolsError, devtoolsActuallyOpened: opened, cdpWhileDevtools }
      }
    })

    await runStep("visibility-toggle", async () => {
      view.setVisible(false)
      const hidden = view.getVisible() === false
      view.setVisible(true)
      const shown = view.getVisible() === true
      return { hidden, shown }
    })

    await runStep("ax-quality-complex-spa", async () => {
      // Load a complex public SPA and measure AX coverage. (The opencode UI itself
      // cannot run in the spike view: it requires the preload bridge, which the
      // spike view intentionally does not mount.)
      const target = "https://github.com/microsoft/vscode"
      await waitForLoad(target)
      // give the SPA time to hydrate
      await new Promise((r) => setTimeout(r, 4000))
      const probe = await runCdpProbe("github")
      return { target, shotFile: probe.shotFile, ...probe.axSummary }
    })

    await runStep("focus-check", async () => {
      view.webContents.focus()
      await new Promise((r) => setTimeout(r, 500))
      return {
        winFocused: win.isFocused(),
        focusedWebContentsId: BrowserWindow.getFocusedWindow()?.webContents.id,
        spikeViewWebContentsId: view.webContents.id,
      }
    })

    await runStep("bridge-client", async () => {
      // P0-D-03: WS client mechanics (req/resp correlation + reconnect) against a
      // standalone echo server (scripts/spike-bridge-echo.ts). Server-side endpoint
      // (ticket route) lands in P1-S-02.
      const url = process.env.OPENCODE_SPIKE_BRIDGE_URL ?? "ws://127.0.0.1:9777"
      let ws: WebSocket | undefined
      let reconnects = 0
      const connect = (): Promise<void> =>
        new Promise((resolve, reject) => {
          const sock = new WebSocket(url)
          sock.addEventListener("open", () => resolve(), { once: true })
          sock.addEventListener("error", () => reject(new Error(`connect failed: ${url}`)), { once: true })
          ws = sock
        })
      await connect()

      const roundtrip = (payload: Record<string, unknown>, timeoutMs = 5000) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("socket not open"))
          const id = `r${Math.random().toString(36).slice(2)}`
          const timer = setTimeout(() => reject(new Error(`roundtrip timeout id=${id}`)), timeoutMs)
          const onMessage = (event: MessageEvent) => {
            const data = JSON.parse(String(event.data))
            if (data.type !== "resp" || data.id !== id) return
            clearTimeout(timer)
            ws?.removeEventListener("message", onMessage)
            resolve(data.result as Record<string, unknown>)
          }
          ws.addEventListener("message", onMessage)
          ws.send(JSON.stringify({ type: "cmd", id, ...payload }))
        })

      // 20 roundtrips for latency profile
      const latencies: number[] = []
      for (let i = 0; i < 20; i++) {
        const started = performance.now()
        const result = await roundtrip({ type: "ping" })
        latencies.push(performance.now() - started)
        if (!(result as { pong?: boolean }).pong) throw new Error(`unexpected result: ${JSON.stringify(result)}`)
      }
      latencies.sort((a, b) => a - b)
      const latency = {
        p50: Math.round(latencies[10] * 100) / 100,
        p95: Math.round(latencies[18] * 100) / 100,
        max: Math.round(latencies[19] * 100) / 100,
      }

      // Reconnect watch: the echo server is killed/restarted externally. The client
      // retries with capped backoff (mirrors the planned BridgeClient behavior) and
      // completes once a roundtrip succeeds again.
      const reconnectDeadline = Date.now() + 120_000
      let attempts = 0
      for (;;) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const closed = new Promise<void>((resolve) => {
            const sock = ws!
            sock.addEventListener("close", () => resolve(), { once: true })
          })
          log("bridge", "watching for external server restart (socket open)")
          await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))])
          if (ws && ws.readyState === WebSocket.OPEN) {
            if (Date.now() > reconnectDeadline) throw new Error("reconnect watch timed out with socket open")
            continue // still open, keep watching
          }
        }
        attempts++
        const backoff = Math.min(500 * 2 ** Math.min(attempts - 1, 5), 8000)
        log("bridge", `reconnect attempt ${attempts} in ${backoff}ms`)
        await new Promise((r) => setTimeout(r, backoff))
        try {
          await connect()
        } catch (error) {
          log("bridge", `reconnect attempt ${attempts} failed`, { error: String(error) })
          if (Date.now() > reconnectDeadline) throw error
          continue
        }
        log("bridge", `reconnected after ${attempts} attempts`)
        await roundtrip({ type: "ping" })
        reconnects = attempts
        break
      }

      ws?.close()
      return { url, latency, reconnects, reconnectAttempts: attempts }
    })

    const summary = { startedAt: Date.now(), steps }
    writeFileSync(join(spikeDir(), "summary.json"), JSON.stringify(summary, null, 2))
    log("done", "spike finished", {
      passed: steps.filter((s) => s.ok).length,
      failed: steps.filter((s) => !s.ok).length,
      summaryFile: join(spikeDir(), "summary.json"),
    })
  })()
}
