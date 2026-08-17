type CdpTarget = {
  type: string
  url: string
  webSocketDebuggerUrl: string
}

type CdpResponse = {
  id?: number
  result?: unknown
  error?: { message: string }
}

type HeapUsage = {
  usedSize: number
  totalSize: number
  embedderHeapUsedSize: number
  backingStorageSize: number
}

type DomCounters = {
  documents: number
  nodes: number
  jsEventListeners: number
}

type Options = {
  endpoint: string
  iterations: number
  tabs: number
  workspaces: number
  settleMs: number
  maxP95: number
  maxHeapGrowth: number
  maxNodeGrowth: number
  maxListenerGrowth: number
}

const defaults: Options = {
  endpoint: "http://127.0.0.1:9222",
  iterations: 10,
  tabs: 3,
  workspaces: 1,
  settleMs: 2_000,
  maxP95: 250,
  maxHeapGrowth: 8 * 1024 * 1024,
  maxNodeGrowth: 2_500,
  maxListenerGrowth: 100,
}

function usage() {
  return [
    "Profile session tab switching, isolation, closing, and retained resources through Electron CDP.",
    "",
    "The Electron development app must already be running with enough unopened sessions in the sidebar.",
    "",
    "Usage: bun run profile:session-tabs -- [options]",
    "",
    "Options:",
    "  --endpoint <url>             CDP HTTP endpoint (default: http://127.0.0.1:9222)",
    "  --iterations <count>         Full rounds across all tabs (default: 10)",
    "  --tabs <count>               Tabs to profile (default: 3)",
    "  --workspaces <count>         Minimum distinct workspaces to open (default: 1)",
    "  --settle-ms <ms>             Wait before retained-resource samples (default: 2000)",
    "  --max-p95 <ms>               Maximum activation P95 (default: 250)",
    "  --max-heap-growth <bytes>    Maximum retained V8 heap after GC (default: 8388608)",
    "  --max-node-growth <count>    Maximum retained DOM nodes (default: 2500)",
    "  --max-listener-growth <n>    Maximum retained event listeners (default: 100)",
    "  --help                       Show this help",
  ].join("\n")
}

function positiveNumber(flag: string, value: string | undefined) {
  const result = Number(value)
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${flag} must be a positive number`)
  return result
}

function parseOptions(args: string[]): Options | undefined {
  const options = { ...defaults }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === "--help") return undefined
    const value = args[++index]
    if (flag === "--endpoint") options.endpoint = value ?? ""
    else if (flag === "--iterations") options.iterations = positiveNumber(flag, value)
    else if (flag === "--tabs") options.tabs = positiveNumber(flag, value)
    else if (flag === "--workspaces") options.workspaces = positiveNumber(flag, value)
    else if (flag === "--settle-ms") options.settleMs = positiveNumber(flag, value)
    else if (flag === "--max-p95") options.maxP95 = positiveNumber(flag, value)
    else if (flag === "--max-heap-growth") options.maxHeapGrowth = positiveNumber(flag, value)
    else if (flag === "--max-node-growth") options.maxNodeGrowth = positiveNumber(flag, value)
    else if (flag === "--max-listener-growth") options.maxListenerGrowth = positiveNumber(flag, value)
    else throw new Error(`Unknown option: ${flag}`)
  }
  options.iterations = Math.floor(options.iterations)
  options.tabs = Math.floor(options.tabs)
  options.workspaces = Math.floor(options.workspaces)
  options.settleMs = Math.floor(options.settleMs)
  if (options.tabs < 2) throw new Error("--tabs must be at least 2")
  if (options.workspaces > options.tabs) throw new Error("--workspaces cannot exceed --tabs")
  return options
}

type HelperMemory = {
  totalRss: number
  rendererRss: number
  nodeServiceRss: number
  gpuRss: number
  networkRss: number
  processes: number
}

async function helperMemory(): Promise<HelperMemory> {
  const process = Bun.spawn(["ps", "-axo", "rss=,command="], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(process.stdout).text()
  await process.exited
  const result: HelperMemory = {
    totalRss: 0,
    rendererRss: 0,
    nodeServiceRss: 0,
    gpuRss: 0,
    networkRss: 0,
    processes: 0,
  }
  for (const line of output.split("\n")) {
    if (!line.includes("/Electron Helper") && !line.includes("/OpenCode Dev Helper")) continue
    if (!line.includes("ai.opencode.desktop.dev")) continue
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (!match) continue
    const rss = Number(match[1]) * 1024
    const command = match[2]
    result.totalRss += rss
    result.processes += 1
    if (command.includes("--type=renderer") && command.includes("--remote-debugging-port=9222"))
      result.rendererRss += rss
    if (command.includes("--utility-sub-type=node.mojom.NodeService")) result.nodeServiceRss += rss
    if (command.includes("--type=gpu-process")) result.gpuRss += rss
    if (command.includes("--utility-sub-type=network.mojom.NetworkService")) result.networkRss += rss
  }
  return result
}

class CdpClient {
  private nextID = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse
      if (message.id === undefined) return
      const callback = this.pending.get(message.id)
      if (!callback) return
      this.pending.delete(message.id)
      if (message.error) callback.reject(new Error(message.error.message))
      else callback.resolve(message.result)
    })
    socket.addEventListener("close", () => {
      for (const callback of this.pending.values()) callback.reject(new Error("CDP connection closed"))
      this.pending.clear()
    })
  }

  static async connect(url: string) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error(`Unable to connect to ${url}`)), { once: true })
    })
    return new CdpClient(socket)
  }

  call<T>(method: string, params: Record<string, unknown> = {}) {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextID++
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate<T>(expression: string) {
    const response = await this.call<{ result: { value?: T; description?: string }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
    )
    if (response.exceptionDetails) throw new Error(response.result.description ?? "Renderer evaluation failed")
    return response.result.value as T
  }

  close() {
    this.socket.close()
  }
}

function percentile(values: number[], ratio: number) {
  return values[Math.min(values.length - 1, Math.floor(values.length * ratio))] ?? 0
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (!options) {
    console.log(usage())
    return
  }

  const response = await fetch(`${options.endpoint}/json`)
  if (!response.ok) throw new Error(`CDP target request failed: ${response.status}`)
  const targets = (await response.json()) as CdpTarget[]
  const target = targets.find(
    (item) => item.type === "page" && (item.url.startsWith("http") || item.url.startsWith("oc://")),
  )
  if (!target) throw new Error("Electron renderer target was not found")

  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
  let opened: string[] = []
  let initialActive: string | undefined
  try {
    const settle = () => new Promise((resolve) => setTimeout(resolve, options.settleMs))
    await cdp.call("HeapProfiler.enable")
    console.error(`[profile-session-tabs] stage=initial-settle waitMs=${options.settleMs}`)
    await settle()
    await cdp.call("HeapProfiler.collectGarbage")
    const heapInitial = await cdp.call<HeapUsage>("Runtime.getHeapUsage")
    const domInitial = await cdp.call<DomCounters>("Memory.getDOMCounters")
    const helperInitial = await helperMemory()
    const setup = await cdp.evaluate<{
      initialActive?: string
      opened: string[]
      targets: string[]
      diagnostics: string[]
      error?: string
    }>(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const active = () => document.querySelector('[data-component="session-tab"][data-active="true"]')?.dataset.sessionId
      const tabs = () => [...document.querySelectorAll('[data-component="session-tab"][data-session-id]')]
      const initial = tabs().map((item) => item.dataset.sessionId)
      const initialActive = active()
      const opened = []
      const diagnostics = []
      const targets = []
      const targetWorkspaces = new Set()
      let error
      for (const tab of tabs()) {
        const id = tab.dataset.sessionId
        const directory = tab.dataset.directory
        if (!id || !directory || targetWorkspaces.has(directory)) continue
        targets.push(id)
        targetWorkspaces.add(directory)
        if (targetWorkspaces.size >= ${options.workspaces} || targets.length >= ${options.tabs}) break
      }
      const openLink = async (link, source) => {
        const id = link.getAttribute('href')?.split('/').at(-1)
        if (!id || initial.includes(id) || opened.includes(id)) return false
        diagnostics.push('open-link source=' + source + ' id=' + id)
        link.click()
        const deadline = performance.now() + 10_000
        while (performance.now() < deadline && active() !== id) await new Promise(requestAnimationFrame)
        if (active() !== id) {
          error = 'Timed out opening session tab ' + id
          diagnostics.push('open-link-timeout id=' + id)
          return false
        }
        opened.push(id)
        await sleep(50)
        return true
      }
      const projects = [...new Map(
        [...document.querySelectorAll('[data-action="project-switch"][data-project]')]
          .map((item) => [item.dataset.project, item]),
      ).values()]
      for (const project of projects) {
        if (targets.length >= ${options.tabs}) break
        const openedWorkspaces = new Set(
          tabs().filter((item) => opened.includes(item.dataset.sessionId)).map((item) => item.dataset.directory).filter(Boolean),
        )
        if (targetWorkspaces.size >= ${options.workspaces}) break
        const slug = project.dataset.project
        diagnostics.push('project-click slug=' + slug)
        project.click()
        const deadline = performance.now() + 10_000
        let link
        while (
          performance.now() < deadline &&
          ![...document.querySelectorAll('[data-action="project-switch"][data-project]')].some(
            (item) => item.dataset.project === slug && item.getAttribute('aria-current') === 'true',
          )
        ) {
          await new Promise(requestAnimationFrame)
        }
        await new Promise(requestAnimationFrame)
        const newSession = [...document.querySelectorAll('.sidebar-action-button[data-icon="new-session"]')]
          .find((item) => item.offsetParent !== null)
        diagnostics.push('project-new-session slug=' + slug + ' found=' + String(Boolean(newSession)))
        newSession?.click()
        while (performance.now() < deadline) {
          if (!location.pathname.startsWith('/' + slug + '/session')) {
            await new Promise(requestAnimationFrame)
            continue
          }
          link = [...document.querySelectorAll('a[href*="/session/"]')]
            .find((item) => item.getAttribute('href')?.startsWith('/' + slug + '/session/'))
          if (link) break
          await new Promise(requestAnimationFrame)
        }
        diagnostics.push('project-links slug=' + slug + ' found=' + String(Boolean(link)))
        if (link && (await openLink(link, 'project'))) {
          const id = opened.at(-1)
          const tab = tabs().find((item) => item.dataset.sessionId === id)
          if (id) targets.push(id)
          if (tab?.dataset.directory) targetWorkspaces.add(tab.dataset.directory)
        }
      }
      const links = [...new Map(
        [...document.querySelectorAll('a[href*="/session/"]')]
          .map((item) => [item.getAttribute('href'), item]),
      ).values()]
      for (const link of links) {
        if (targets.length >= ${options.tabs}) break
        if (await openLink(link, 'sidebar')) {
          const id = opened.at(-1)
          const tab = tabs().find((item) => item.dataset.sessionId === id)
          if (id) targets.push(id)
          if (tab?.dataset.directory) targetWorkspaces.add(tab.dataset.directory)
        }
      }
      if (targets.length < ${options.tabs}) {
        error ||= 'Expected ${options.tabs} session tabs, found ' + targets.length + '. Load more sessions in the sidebar.'
      }
      const workspaceCount = new Set(
        tabs().filter((item) => targets.includes(item.dataset.sessionId)).map((item) => item.dataset.directory).filter(Boolean),
      ).size
      diagnostics.push(
        'opened=' +
          opened.length +
          ' workspaceCount=' +
          workspaceCount +
          ' tabDirectories=' +
          tabs()
            .filter((item) => targets.includes(item.dataset.sessionId))
            .map((item) => item.dataset.directory || 'missing')
            .join('|'),
      )
      if (workspaceCount < ${options.workspaces}) {
        error ||= 'Expected ${options.workspaces} workspaces, opened ' + workspaceCount + '.'
      }
      return { initialActive, opened, targets, diagnostics, error }
    })()`)
    opened = setup.opened
    initialActive = setup.initialActive
    if (setup.error) throw new Error(setup.error + " diagnostics=" + setup.diagnostics.join(" ; "))

    const activate = async (id: string) => {
      await cdp.evaluate(`(async () => {
        const id = ${JSON.stringify(id)}
        const tab = [...document.querySelectorAll('[data-component="session-tab"][data-session-id]')]
          .find((item) => item.dataset.sessionId === id)
        if (!tab) throw new Error('Missing session tab ' + id)
        tab.click()
        const deadline = performance.now() + 10_000
        while (
          performance.now() < deadline &&
          document.querySelector('[data-component="session-tab"][data-active="true"]')?.dataset.sessionId !== id
        ) await new Promise(requestAnimationFrame)
      })()`)
    }

    await activate(setup.targets.at(-1)!)
    console.error(`[profile-session-tabs] stage=opened tabs=${setup.targets.length} settleMs=${options.settleMs}`)
    await settle()
    await cdp.call("HeapProfiler.collectGarbage")
    const heapBefore = await cdp.call<HeapUsage>("Runtime.getHeapUsage")
    const domBefore = await cdp.call<DomCounters>("Memory.getDOMCounters")
    const helperBefore = await helperMemory()

    const profile = await cdp.evaluate<{
      times: number[]
      timeouts: string[]
      longTasks: number
      longTaskDuration: number
    }>(`(async () => {
      const ids = ${JSON.stringify(setup.targets)}
      const times = []
      const timeouts = []
      const longTasks = []
      const observer = new PerformanceObserver((list) => {
        longTasks.push(...list.getEntries().map((item) => item.duration))
      })
      try { observer.observe({ type: 'longtask', buffered: true }) } catch {}
      for (let round = 0; round < ${options.iterations}; round++) {
        for (const id of ids) {
          const tab = [...document.querySelectorAll('[data-component="session-tab"][data-session-id]')]
            .find((item) => item.dataset.sessionId === id)
          const start = performance.now()
          tab?.click()
          const deadline = start + 10_000
          while (
            performance.now() < deadline &&
            document.querySelector('[data-component="session-tab"][data-active="true"]')?.dataset.sessionId !== id
          ) await new Promise(requestAnimationFrame)
          const duration = performance.now() - start
          if (document.querySelector('[data-component="session-tab"][data-active="true"]')?.dataset.sessionId === id) {
            times.push(duration)
          } else {
            timeouts.push(id)
          }
        }
      }
      observer.disconnect()
      return {
        times,
        timeouts,
        longTasks: longTasks.length,
        longTaskDuration: longTasks.reduce((sum, value) => sum + value, 0),
      }
    })()`)

    if (profile.timeouts.length > 0) throw new Error(`Session activation timed out ${profile.timeouts.length} times`)
    profile.times.sort((left, right) => left - right)

    const isolation = await cdp.evaluate<{
      checked: boolean
      leaked: boolean
      restored: boolean
      reason?: string
    }>(`(async () => {
      const ids = ${JSON.stringify(setup.targets.slice(-2))}
      const marker = ['__CDP_SESSION_A__', '__CDP_SESSION_B__']
      const activate = async (id) => {
        const tab = [...document.querySelectorAll('[data-component="session-tab"][data-session-id]')]
          .find((item) => item.dataset.sessionId === id)
        tab?.click()
        const deadline = performance.now() + 10_000
        while (
          performance.now() < deadline &&
          document.querySelector('[data-component="session-tab"][data-active="true"]')?.dataset.sessionId !== id
        ) await new Promise(requestAnimationFrame)
      }
      const editor = () => document.querySelector('[data-component="prompt-input"][contenteditable="true"]')
      const write = (value) => {
        const input = editor()
        input.textContent = value
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      }
      await activate(ids[0])
      const originalA = editor()?.textContent ?? ''
      await activate(ids[1])
      const originalB = editor()?.textContent ?? ''
      if (originalA || originalB) return { checked: false, leaked: false, restored: false, reason: 'prompt is not empty' }
      await activate(ids[0])
      write(marker[0])
      await activate(ids[1])
      const leaked = editor()?.textContent === marker[0]
      write(marker[1])
      await activate(ids[0])
      const restoredA = editor()?.textContent === marker[0]
      write(originalA)
      await activate(ids[1])
      const restoredB = editor()?.textContent === marker[1]
      write(originalB)
      return { checked: true, leaked, restored: restoredA && restoredB }
    })()`)
    if (isolation.checked && (isolation.leaked || !isolation.restored)) {
      throw new Error("Session prompt state leaked between tabs")
    }

    await activate(setup.targets.at(-1)!)
    console.error(
      `[profile-session-tabs] stage=switched activations=${profile.times.length} settleMs=${options.settleMs}`,
    )
    await settle()
    await cdp.call("HeapProfiler.collectGarbage")
    const heapAfterSwitch = await cdp.call<HeapUsage>("Runtime.getHeapUsage")
    const domAfterSwitch = await cdp.call<DomCounters>("Memory.getDOMCounters")
    const helperAfterSwitch = await helperMemory()

    const close = await cdp.evaluate<{ results: { id: string; kind: string; duration: number; valid: boolean }[] }>(
      `(async () => {
        const opened = ${JSON.stringify(opened)}
        const results = []
        const tabs = () => [...document.querySelectorAll('[data-component="session-tab"][data-session-id]')]
        const active = () => document.querySelector('[data-component="session-tab"][data-active="true"]')?.dataset.sessionId
        const closeTab = async (id, kind) => {
          const beforeActive = active()
          const tab = tabs().find((item) => item.dataset.sessionId === id)
          const start = performance.now()
          tab?.querySelector('[aria-label="关闭标签页"]')?.click()
          const deadline = start + 10_000
          while (performance.now() < deadline && tabs().some((item) => item.dataset.sessionId === id)) {
            await new Promise(requestAnimationFrame)
          }
          const afterActive = active()
          results.push({
            id,
            kind,
            duration: performance.now() - start,
            valid: kind === 'inactive' ? beforeActive === afterActive : afterActive !== id,
          })
        }
        const firstInactive = opened.find((id) => id !== active())
        if (firstInactive) await closeTab(firstInactive, 'inactive')
        for (const id of opened) {
          if (!tabs().some((item) => item.dataset.sessionId === id)) continue
          tabs().find((item) => item.dataset.sessionId === id)?.click()
          const deadline = performance.now() + 10_000
          while (performance.now() < deadline && active() !== id) await new Promise(requestAnimationFrame)
          await closeTab(id, 'active')
        }
        return { results }
      })()`,
    )
    if (close.results.some((item) => !item.valid)) throw new Error("Session close selected the wrong neighboring tab")

    if (initialActive) await activate(initialActive)
    console.error(`[profile-session-tabs] stage=closed closed=${close.results.length} settleMs=${options.settleMs}`)
    await settle()
    await cdp.call("HeapProfiler.collectGarbage")
    const heapAfterClose = await cdp.call<HeapUsage>("Runtime.getHeapUsage")
    const domAfterClose = await cdp.call<DomCounters>("Memory.getDOMCounters")
    const helperAfterClose = await helperMemory()

    const p50 = percentile(profile.times, 0.5)
    const p95 = percentile(profile.times, 0.95)
    const p99 = percentile(profile.times, 0.99)
    const heapGrowth = heapAfterClose.usedSize - heapInitial.usedSize
    const nodeGrowth = domAfterClose.nodes - domInitial.nodes
    const listenerGrowth = domAfterClose.jsEventListeners - domInitial.jsEventListeners
    const summary = {
      tabs: setup.targets.length,
      activations: profile.times.length,
      activationMs: {
        mean: profile.times.reduce((sum, value) => sum + value, 0) / profile.times.length,
        p50,
        p95,
        p99,
        max: Math.max(...profile.times),
      },
      longTasks: { count: profile.longTasks, duration: profile.longTaskDuration },
      isolation,
      close: close.results,
      resources: {
        initial: { heap: heapInitial.usedSize, nodes: domInitial.nodes, listeners: domInitial.jsEventListeners },
        beforeSwitch: { heap: heapBefore.usedSize, nodes: domBefore.nodes, listeners: domBefore.jsEventListeners },
        afterSwitch: {
          heap: heapAfterSwitch.usedSize,
          nodes: domAfterSwitch.nodes,
          listeners: domAfterSwitch.jsEventListeners,
        },
        afterClose: {
          heap: heapAfterClose.usedSize,
          nodes: domAfterClose.nodes,
          listeners: domAfterClose.jsEventListeners,
        },
        retained: { heap: heapGrowth, nodes: nodeGrowth, listeners: listenerGrowth },
        helper: {
          initial: helperInitial,
          beforeSwitch: helperBefore,
          afterSwitch: helperAfterSwitch,
          afterClose: helperAfterClose,
          retainedRss: helperAfterClose.totalRss - helperInitial.totalRss,
          retainedRendererRss: helperAfterClose.rendererRss - helperInitial.rendererRss,
        },
      },
    }
    console.log(JSON.stringify(summary, null, 2))

    const failures = [
      p95 > options.maxP95 ? `activation P95 ${p95.toFixed(1)}ms exceeds ${options.maxP95}ms` : undefined,
      heapGrowth > options.maxHeapGrowth
        ? `retained heap ${heapGrowth} exceeds ${options.maxHeapGrowth} bytes`
        : undefined,
      nodeGrowth > options.maxNodeGrowth ? `retained nodes ${nodeGrowth} exceeds ${options.maxNodeGrowth}` : undefined,
      listenerGrowth > options.maxListenerGrowth
        ? `retained listeners ${listenerGrowth} exceeds ${options.maxListenerGrowth}`
        : undefined,
    ].filter((item): item is string => !!item)
    if (failures.length > 0) throw new Error(failures.join("; "))
  } finally {
    if (opened.length > 0) {
      await cdp
        .evaluate(
          `(async () => {
          const ids = ${JSON.stringify(opened)}
          for (const id of ids) {
            const tab = [...document.querySelectorAll('[data-component="session-tab"][data-session-id]')]
              .find((item) => item.dataset.sessionId === id)
            tab?.querySelector('[aria-label="关闭标签页"]')?.click()
            const deadline = performance.now() + 5_000
            while (
              performance.now() < deadline &&
              [...document.querySelectorAll('[data-component="session-tab"][data-session-id]')]
                .some((item) => item.dataset.sessionId === id)
            ) await new Promise(requestAnimationFrame)
          }
        })()`,
        )
        .catch(() => undefined)
    }
    if (initialActive)
      await cdp
        .evaluate(`document.querySelector('[data-session-id=${JSON.stringify(initialActive)}]')?.click()`)
        .catch(() => undefined)
    cdp.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
