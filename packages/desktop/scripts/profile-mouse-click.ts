import { connectCdp, type CdpClient } from "./cdp"

type TabTarget = {
  id: string
  active?: string
  x: number
  y: number
}

type ProbeEvent = {
  kind: string
  t: number
  id?: string | null
  active?: string | null
  trusted?: boolean
  gap?: number
  duration?: number
}

const endpoint = Bun.env.OPENCODE_CDP_ENDPOINT ?? "http://127.0.0.1:9222"
const clicks = Number(Bun.env.OPENCODE_MOUSE_CLICKS ?? 4)
const settleMs = Number(Bun.env.OPENCODE_MOUSE_SETTLE_MS ?? 2_500)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function log(stage: string, fields = "") {
  console.error(`[profile-mouse-click] stage=${stage}${fields ? ` ${fields}` : ""}`)
}

async function installProbe(cdp: CdpClient) {
  return cdp.evaluate<{ active: string | null }>(`(() => {
    const previous = globalThis.__opencodeMouseClickProbe
    previous?.stop?.()
    const started = performance.now()
    const events = []
    let stopped = false
    let lastFrame = started
    const tabSelector = '[data-component="session-tab"]'
    const active = () => document.querySelector('[data-component="session-tab"][data-active="true"]')?.dataset.sessionId ?? null
    const record = (kind, fields = {}) => {
      if (events.length >= 2000) return
      events.push({ kind, t: Math.round(performance.now() - started), ...fields })
    }
    const pointer = (event) => {
      const target = event.target instanceof Element ? event.target.closest(tabSelector) : null
      record(event.type, { id: target?.dataset.sessionId ?? null, active: active(), trusted: event.isTrusted })
    }
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('click', pointer, true)
    const attributes = new MutationObserver((records) => {
      for (const item of records) {
        if (item.type !== 'attributes' || !(item.target instanceof HTMLElement)) continue
        record('active-attribute', { id: item.target.dataset.sessionId, active: item.target.dataset.active ?? null })
      }
    })
    attributes.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-active'] })
    const frames = (now) => {
      if (stopped) return
      const gap = now - lastFrame
      if (gap > 40) record('frame-gap', { gap: Math.round(gap) })
      lastFrame = now
      requestAnimationFrame(frames)
    }
    requestAnimationFrame(frames)
    let longTasks
    try {
      longTasks = new PerformanceObserver((list) => {
        for (const item of list.getEntries()) record('longtask', { duration: Math.round(item.duration) })
      })
      longTasks.observe({ type: 'longtask' })
    } catch {}
    const stop = () => {
      if (stopped) return
      stopped = true
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('click', pointer, true)
      attributes.disconnect()
      longTasks?.disconnect()
    }
    globalThis.__opencodeMouseClickProbe = { events, stop, active }
    return { active: active() }
  })()`)
}

async function getTarget(cdp: CdpClient, index: number): Promise<TabTarget | undefined> {
  return cdp.evaluate<TabTarget | undefined>(`(() => {
    const tabs = [...document.querySelectorAll('[data-component="session-tab"][data-session-id]')]
    const active = tabs.find((item) => item.dataset.active === 'true')?.dataset.sessionId
    const target = tabs.filter((item) => item.dataset.sessionId !== active)[${index}]
    if (!target) return undefined
    const rect = target.getBoundingClientRect()
    return { id: target.dataset.sessionId, active, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
}

async function collectProbe(cdp: CdpClient) {
  return cdp.evaluate<{ events: ProbeEvent[]; active: string | null }>(`(() => {
    const probe = globalThis.__opencodeMouseClickProbe
    if (!probe) return { events: [], active: null }
    probe.stop()
    return { events: probe.events, active: probe.active() }
  })()`)
}

async function physicalMouseClick(x: number, y: number) {
  if (process.platform !== "win32") {
    throw new Error("Physical mouse profiling is currently implemented for Windows only")
  }
  const script = [
    "$ownerPid = [int](Get-NetTCPConnection -State Listen -LocalPort 9222 -ErrorAction Stop | Select-Object -First 1).OwningProcess",
    '$source = \'using System; using System.Runtime.InteropServices; public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } public static class NativeMouse { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra); }\'',
    "Add-Type -TypeDefinition $source",
    "$window = Get-Process -Id $ownerPid -ErrorAction Stop",
    "$rect = New-Object RECT",
    "[NativeMouse]::GetWindowRect($window.MainWindowHandle, [ref]$rect) | Out-Null",
    "[NativeMouse]::SetForegroundWindow($window.MainWindowHandle) | Out-Null",
    `[NativeMouse]::SetCursorPos([int]($rect.Left + ${Math.round(x)}), [int]($rect.Top + ${Math.round(y)})) | Out-Null`,
    "Start-Sleep -Milliseconds 80",
    "[NativeMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)",
    "Start-Sleep -Milliseconds 60",
    "[NativeMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
  ].join("; ")
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Physical mouse click failed: ${stderr.trim() || `exit ${code}`}`)
}

async function main() {
  if (!Number.isInteger(clicks) || clicks <= 0) throw new Error("OPENCODE_MOUSE_CLICKS must be a positive integer")
  const { client: cdp } = await connectCdp(endpoint)
  try {
    log("connected", `endpoint=${endpoint} clicks=${clicks} settleMs=${settleMs}`)
    const initial = await installProbe(cdp)
    log("probe-installed", `active=${initial.active ?? "none"}`)

    for (let index = 0; index < clicks; index++) {
      const target = await getTarget(cdp, index % Math.max(clicks, 2))
      if (!target) {
        log("click-skipped", `index=${index} reason=no-inactive-tab`)
        continue
      }
      log(
        "mouse-down",
        `index=${index} target=${target.id} before=${target.active ?? "none"} x=${Math.round(target.x)} y=${Math.round(target.y)}`,
      )
      await physicalMouseClick(target.x, target.y)
      await sleep(settleMs)
      const state = await cdp.evaluate<{ active: string | null }>(
        `({ active: document.querySelector('[data-component="session-tab"][data-active="true"]')?.dataset.sessionId ?? null })`,
      )
      log("mouse-settled", `index=${index} target=${target.id} active=${state.active ?? "none"}`)
    }

    const result = await collectProbe(cdp)
    const longTasks = result.events.filter((event) => event.kind === "longtask")
    const frameGaps = result.events.filter((event) => event.kind === "frame-gap")
    const clicksSeen = result.events.filter((event) => event.kind === "click")
    const activeChanges = result.events.filter((event) => event.kind === "active-attribute")
    const summary = {
      active: result.active,
      clicksSeen: clicksSeen.length,
      activeChanges: activeChanges.length,
      longTasks: {
        count: longTasks.length,
        maxMs: Math.max(0, ...longTasks.map((event) => event.duration ?? 0)),
        totalMs: longTasks.reduce((sum, event) => sum + (event.duration ?? 0), 0),
      },
      frameGaps: {
        count: frameGaps.length,
        maxMs: Math.max(0, ...frameGaps.map((event) => event.gap ?? 0)),
      },
      events: result.events,
    }
    log(
      "complete",
      `clicksSeen=${clicksSeen.length} activeChanges=${activeChanges.length} longTasks=${longTasks.length} maxFrameGap=${summary.frameGaps.maxMs}`,
    )
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    cdp.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
