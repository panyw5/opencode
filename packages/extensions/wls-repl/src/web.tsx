import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { defineWebExtension, type ExtensionContext, type FileViewerProps } from "@opencode-ai/extension-kit/web"
import "./web.css"
import { messages } from "./i18n"
import { createWlsHighlight } from "./highlight"
import { VIRTUAL_THRESHOLD, centeredScrollTop, maxColumns, visibleRange } from "./viewport"

const EXTENSION_ID = "local.wls-repl"
const MESSAGE_EVENT = `${EXTENSION_ID}/message`
const DEFAULT_FONT_SIZE = 12.5
const MIN_FONT_SIZE = 9
const MAX_FONT_SIZE = 24
const LINE_HEIGHT_RATIO = 1.6

type Bridge = {
  rpc?: ExtensionContext["rpc"]
  events?: ExtensionContext["events"]
  log?: ExtensionContext["log"]
  settings?: ExtensionContext["settings"]
}
const [bridge, setBridge] = createSignal<Bridge>({})

type KernelStatus = "unknown" | "starting" | "ready" | "running" | "paused" | "error" | "stopped"

type ConsoleEntry = {
  id: number
  kind: "out" | "err" | "result" | "input" | "info" | "pending"
  text: string
}

const MAX_CONSOLE_ENTRIES = 500

let entrySeq = 0

/**
 * Bridge definitions look like `HoldPattern[a] :> 1` / `HoldPattern[f[x_]] :> x + 1`;
 * render them as `a = 1` / `f[x_] := x + 1`.
 */
export function prettyDefinition(raw: string): string {
  return raw
    .split("; ")
    .filter((part) => part !== "")
    .map((part) => {
      const stripped = part.replace(/^HoldPattern\[/, "")
      const marker = stripped.indexOf("] :> ")
      if (marker === -1) return stripped
      const lhs = stripped.slice(0, marker)
      const rhs = stripped.slice(marker + 5)
      return `${lhs} ${lhs.includes("[") ? ":=" : "="} ${rhs}`
    })
    .join("; ")
}

/**
 * The name column already shows the symbol name; drop a redundant leading
 * `name =` / `name :=` from the definition text.
 */
export function stripNamePrefix(name: string, definition: string): string {
  for (const separator of [" = ", " := "]) {
    const prefix = name + separator
    if (definition.startsWith(prefix)) return definition.slice(prefix.length)
  }
  return definition
}

export function WlsViewer(props: FileViewerProps) {
  const [locale, setLocale] = createSignal(document.documentElement.lang || "en")
  const t = createMemo(() => messages(locale()))
  onMount(() => {
    const observer = new MutationObserver(() => setLocale(document.documentElement.lang || "en"))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] })
    bridge().log?.info(
      `wls viewer layout mounted ${JSON.stringify({ path: props.file.absolutePath, pinnedInput: true })}`,
    )
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => bridge().log?.info(`wls viewer locale ${locale()}`))
  const filePath = () => props.file.absolutePath
  const [codeText, setCodeText] = createSignal(props.text() ?? "")
  const [status, setStatus] = createSignal<KernelStatus>("unknown")
  const [version, setVersion] = createSignal<string | undefined>(undefined)
  const [pausedLine, setPausedLine] = createSignal<number | undefined>(undefined)
  const [variables, setVariables] = createSignal<Array<[string, string]>>([])
  const [breakpoints, setBreakpoints] = createSignal<number[]>([])
  const [entries, setEntries] = createSignal<ConsoleEntry[]>([])
  const [inputText, setInputText] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  let consoleRef: HTMLDivElement | undefined
  let codeRef: HTMLDivElement | undefined
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewportHeight, setViewportHeight] = createSignal(600)
  const wordWrap = createMemo(() => bridge().settings?.get<boolean>("wordWrap")() ?? true)
  const fontSize = createMemo(() => {
    const value = bridge().settings?.get<number>("fontSize")()
    return typeof value === "number" && value >= MIN_FONT_SIZE && value <= MAX_FONT_SIZE ? value : DEFAULT_FONT_SIZE
  })
  const lineHeight = createMemo(() => Math.max(10, Math.round(fontSize() * LINE_HEIGHT_RATIO)))
  const lines = createMemo(() => codeText().split("\n"))
  const virtual = createMemo(() => lines().length > VIRTUAL_THRESHOLD)
  const columns = createMemo(() => (virtual() ? maxColumns(lines()) : 0))
  const range = createMemo(
    () =>
      virtual()
        ? visibleRange(lines().length, scrollTop(), viewportHeight(), lineHeight())
        : { start: 0, end: lines().length },
    undefined,
    { equals: (a, b) => a.start === b.start && a.end === b.end },
  )
  const [highlightRevision, setHighlightRevision] = createSignal(0)
  const highlight = createMemo(() => createWlsHighlight(codeText(), lines()))
  createEffect(() => {
    const index = highlight()
    let timer: ReturnType<typeof setTimeout> | undefined
    const advance = () => {
      const done = index.advance()
      setHighlightRevision((value) => value + 1)
      if (!done) timer = setTimeout(advance, 0)
    }
    advance()
    onCleanup(() => {
      clearTimeout(timer)
      index.dispose()
    })
  })
  const visibleLines = createMemo(() => {
    highlightRevision()
    return lines()
      .slice(range().start, range().end)
      .map((text, index) => ({
        text,
        number: range().start + index + 1,
        tokens: highlight().tokens(range().start + index),
      }))
  })

  onMount(() => {
    if (!codeRef) return
    const observer = new ResizeObserver(() => setViewportHeight(codeRef!.clientHeight))
    observer.observe(codeRef)
    setViewportHeight(codeRef.clientHeight)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const count = lines().length
    bridge().log?.info(`wls viewer indexed ${JSON.stringify({ path: filePath(), lines: count, virtual: virtual() })}`)
    // Reconcile a stale scroll position when a watched file becomes shorter.
    if (codeRef) setScrollTop(codeRef.scrollTop)
  })

  const append = (kind: ConsoleEntry["kind"], text: string) => {
    setEntries((prev) => {
      const next = [...prev, { id: ++entrySeq, kind, text }]
      return next.length > MAX_CONSOLE_ENTRIES ? next.slice(next.length - MAX_CONSOLE_ENTRIES) : next
    })
  }

  const refreshText = async () => {
    try {
      bridge().log?.info(`wls viewer reading ${filePath()}`)
      const text = await props.readText()
      if (typeof text === "string") {
        setCodeText(text)
        bridge().log?.info(`wls viewer read complete ${JSON.stringify({ path: filePath(), characters: text.length })}`)
      }
    } catch (error) {
      bridge().log?.warn(`wls viewer read failed; using cached text ${filePath()}: ${String(error)}`)
    }
  }

  createEffect(() => {
    props.revision?.()
    untrack(() => void refreshText())
  })

  createEffect(() => {
    const el = consoleRef
    if (el) el.scrollTop = el.scrollHeight
  })

  createEffect(() => {
    const line = pausedLine()
    if (line === undefined || !codeRef) return
    if (virtual()) {
      codeRef.scrollTop = centeredScrollTop(line, viewportHeight(), lineHeight())
      setScrollTop(codeRef.scrollTop)
    } else {
      const target = codeRef.querySelector(`[data-line="${line}"]`)
      target?.scrollIntoView({ block: "center" })
    }
    bridge().log?.info(`wls viewer pause navigation ${JSON.stringify({ path: filePath(), line, virtual: virtual() })}`)
  })

  const toggleBreakpoint = (line: number) => {
    setBreakpoints((prev) => (prev.includes(line) ? prev.filter((value) => value !== line) : [...prev, line]))
  }

  const call = async <T,>(method: string, input: Record<string, unknown>): Promise<T | undefined> => {
    const rpc = bridge().rpc
    if (!rpc) {
      append("err", "server bridge not available in this host")
      return undefined
    }
    try {
      bridge().log?.info(`wls viewer rpc request ${JSON.stringify({ method, path: filePath() })}`)
      const result = await rpc.call<T>(method, input)
      bridge().log?.info(`wls viewer rpc complete ${JSON.stringify({ method, path: filePath() })}`)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      bridge().log?.warn(`wls viewer rpc failed ${method}: ${message}`)
      append("err", `${method}: ${message}`)
      return undefined
    }
  }

  const run = async () => {
    setBusy(true)
    try {
      await refreshText()
      const result = await call<{ started: boolean }>("kernel.run", {
        path: filePath(),
        code: codeText(),
        breakpoints: breakpoints(),
      })
      if (result?.started) {
        setStatus("running")
        setPausedLine(undefined)
        append("info", `run started (${breakpoints().length} breakpoint${breakpoints().length === 1 ? "" : "s"})`)
      }
    } finally {
      setBusy(false)
    }
  }

  const pausedCommand = (op: "continue" | "step" | "abort") => async () => {
    await call("kernel." + op, { path: filePath() })
  }

  const restart = async () => {
    setBusy(true)
    try {
      const result = await call<{ status: KernelStatus }>("kernel.restart", { path: filePath() })
      if (result?.status) {
        setStatus(result.status)
        setPausedLine(undefined)
        setVariables([])
        append("info", "kernel restarted; user variables were reset")
      }
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    await call("kernel.stop", { path: filePath() })
  }

  const submitInput = async () => {
    const code = inputText().trim()
    if (!code) return
    setInputText("")
    append("input", code)
    const result = await call<{ queued: boolean; id: string }>("kernel.eval", {
      path: filePath(),
      code,
    })
    if (result?.queued) {
      append("pending", `awaiting result (${result.id})`)
    }
  }

  const onMessage = (data: unknown) => {
    if (!data || typeof data !== "object") return
    const payload = data as {
      path?: string
      kind?: string
      type?: string
      text?: string
      line?: number
      variables?: Record<string, string>
      aborted?: boolean
      code?: number | null
      id?: string
      ok?: boolean
      version?: string
    }
    if (payload.path !== filePath()) return
    bridge().log?.info(
      `wls viewer message ${JSON.stringify({ path: payload.path, kind: payload.kind, type: payload.type })}`,
    )
    if (payload.kind === "output") {
      append("out", payload.text ?? "")
      return
    }
    if (payload.kind === "stderr") {
      append("err", payload.text ?? "")
      return
    }
    if (payload.kind !== "protocol") return
    switch (payload.type) {
      case "ready":
        setStatus("ready")
        setVersion(payload.version)
        append("info", `kernel ready (${payload.version ?? "unknown version"})`)
        break
      case "paused":
        setStatus("paused")
        setPausedLine(payload.line)
        setVariables(
          Object.entries(payload.variables ?? {})
            .filter(([, raw]) => raw !== "")
            .map(([name, raw]) => [name, stripNamePrefix(name, prettyDefinition(raw))] as [string, string]),
        )
        append("info", `paused at line ${payload.line}`)
        break
      case "done":
        setStatus("ready")
        setPausedLine(undefined)
        setVariables([])
        append("info", payload.aborted === true ? "run aborted" : "run finished")
        break
      case "result":
        append("result", `[line ${payload.line}] ${payload.text ?? ""}`)
        break
      case "error":
        append("err", payload.text ?? "evaluation error")
        break
      case "inspect-result":
      case "eval-result":
        append("result", `${payload.ok === false ? "error: " : ""}${payload.text ?? ""}`)
        break
      case "bridge-error":
        setStatus("error")
        append("err", payload.text ?? "bridge error")
        break
      case "kernel-exit":
        setStatus("stopped")
        setPausedLine(undefined)
        append("info", `kernel exited${payload.code !== undefined ? ` (code ${payload.code})` : ""}`)
        break
      case "kernel-error":
        setStatus("error")
        append("err", payload.text ?? "kernel failed to start — is wolframscript installed and on PATH?")
        break
      default:
        break
    }
  }

  // Event delivery: the host routes SSE events through a module-level bridge
  // so every open .wls tab filters messages by its own file path.
  createEffect(() => {
    const events = bridge().events
    if (!events) return
    const off = events.on(MESSAGE_EVENT, onMessage)
    onCleanup(() => off.dispose())
  })

  const setSetting = (patch: Record<string, unknown>) => {
    void bridge()
      .settings?.update(patch)
      .catch((error: unknown) =>
        bridge().log?.warn(`wls viewer settings update failed: ${error instanceof Error ? error.message : String(error)}`),
      )
  }

  const statusLabel = () => {
    switch (status()) {
      case "unknown":
        return t().idle
      case "starting":
        return t().starting
      case "ready":
        return version() ? `${t().ready} (${version()})` : t().ready
      case "running":
        return t().running
      case "paused":
        return pausedLine() !== undefined ? t().pausedLine.replace("{line}", String(pausedLine())) : t().paused
      case "error":
        return t().error
      case "stopped":
        return t().stopped
    }
  }

  const isPaused = () => status() === "paused"

  return (
    <section class="oc-wls-root">
      <header class="oc-wls-toolbar">
        <span class="oc-wls-status" data-status={status()}>
          <span class="oc-wls-status-dot" data-status={status()} />
          {statusLabel()}
        </span>
        <div class="oc-wls-actions">
          <Button
            size="small"
            variant="secondary"
            disabled={busy() || isPaused() || status() === "running"}
            onClick={() => void run()}
          >
            {t().run}
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={!isPaused()}
            onClick={() => void pausedCommand("continue")()}
          >
            {t().continue}
          </Button>
          <Button size="small" variant="secondary" disabled={!isPaused()} onClick={() => void pausedCommand("step")()}>
            {t().step}
          </Button>
          <Button size="small" variant="ghost" disabled={!isPaused()} onClick={() => void pausedCommand("abort")()}>
            {t().abort}
          </Button>
          <Button size="small" variant="ghost" disabled={busy()} onClick={() => void restart()}>
            {t().restart}
          </Button>
          <Button size="small" variant="ghost" onClick={() => void stop()}>
            {t().stop}
          </Button>
          <Button size="small" variant="ghost" onClick={props.showSource}>
            {t().source}
          </Button>
          <Button
            size="small"
            variant={wordWrap() ? "secondary" : "ghost"}
            title={t().wordWrap}
            data-action="toggle-wrap"
            onClick={() => setSetting({ wordWrap: !wordWrap() })}
          >
            {t().wordWrap}
          </Button>
          <span class="oc-wls-font-controls">
            <Button
              size="small"
              variant="ghost"
              title={t().fontDecrease}
              disabled={fontSize() <= MIN_FONT_SIZE}
              onClick={() => setSetting({ fontSize: Math.max(MIN_FONT_SIZE, fontSize() - 1) })}
            >
              A−
            </Button>
            <span class="oc-wls-font-size">{fontSize()}</span>
            <Button
              size="small"
              variant="ghost"
              title={t().fontIncrease}
              disabled={fontSize() >= MAX_FONT_SIZE}
              onClick={() => setSetting({ fontSize: Math.min(MAX_FONT_SIZE, fontSize() + 1) })}
            >
              A+
            </Button>
          </span>
        </div>
      </header>

      <div class="oc-wls-body">
        <div
          class="oc-wls-code"
          ref={codeRef}
          data-virtual={virtual()}
          data-wrap={wordWrap() ? "on" : "off"}
          style={{ "--wls-font-size": `${fontSize()}px`, "--wls-line-height": `${lineHeight()}px` }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div
            class="oc-wls-code-window"
            style={
              virtual()
                ? {
                    "padding-top": `${range().start * lineHeight()}px`,
                    "padding-bottom": `${(lines().length - range().end) * lineHeight()}px`,
                    "min-width": `calc(${columns()}ch + 64px)`,
                  }
                : undefined
            }
          >
            <Index each={visibleLines()}>
              {(row) => {
                const number = () => row().number
                return (
                  <div class="oc-wls-line" data-line={number()} classList={{ "is-paused": pausedLine() === number() }}>
                    <button
                      type="button"
                      class="oc-wls-gutter"
                      classList={{ "has-breakpoint": breakpoints().includes(number()) }}
                      title={t().breakpoint}
                      onClick={() => toggleBreakpoint(number())}
                    >
                      <span class="oc-wls-line-number">{number()}</span>
                      <span class="oc-wls-bp-dot" />
                    </button>
                    <pre class="oc-wls-line-text">
                      <Show when={row().text !== ""} fallback=" ">
                        <For each={row().tokens}>{(token) => <span data-token={token.kind}>{token.text}</span>}</For>
                      </Show>
                    </pre>
                  </div>
                )
              }}
            </Index>
          </div>
        </div>

        <Show when={isPaused()}>
          <aside class="oc-wls-variables">
            <div class="oc-wls-variables-head">{t().variables}</div>
            <Show when={variables().length > 0} fallback={<div class="oc-wls-variables-empty">{t().empty}</div>}>
              <ul class="oc-wls-variables-list">
                <For each={variables()}>
                  {([name, definition]) => (
                    <li>
                      <span class="oc-wls-var-name">{name}</span>
                      <span class="oc-wls-var-value">{definition}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </aside>
        </Show>
      </div>

      <footer class="oc-wls-console">
        <div class="oc-wls-console-entries" ref={consoleRef}>
          <For each={entries()}>
            {(entry) => (
              <div class="oc-wls-entry" data-kind={entry.kind}>
                {entry.text}
              </div>
            )}
          </For>
        </div>
        <div class="oc-wls-input-row">
          <span class="oc-wls-prompt">{isPaused() ? "inspect>" : "In>"}</span>
          <input
            class="oc-wls-input"
            value={inputText()}
            aria-label={isPaused() ? t().inspect : t().input}
            placeholder={isPaused() ? t().inspect : t().input}
            onInput={(event) => setInputText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitInput()
            }}
          />
        </div>
      </footer>
    </section>
  )
}

export default defineWebExtension({
  id: EXTENSION_ID,
  apiVersion: 1,
  activate(context: ExtensionContext) {
    context.log.info("activating wls-repl viewer")
    setBridge({ rpc: context.rpc, events: context.events, log: context.log, settings: context.settings })
    const registration = context.fileViewers.register({ id: "wls-repl", component: WlsViewer })
    return () => {
      registration.dispose()
      setBridge({})
    }
  },
})
