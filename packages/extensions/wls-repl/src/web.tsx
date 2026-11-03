import { For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { defineWebExtension, type ExtensionContext, type FileViewerProps } from "@opencode-ai/extension-kit/web"
import "./web.css"

const EXTENSION_ID = "local.wls-repl"
const MESSAGE_EVENT = `${EXTENSION_ID}/message`

type Bridge = { rpc?: ExtensionContext["rpc"]; events?: ExtensionContext["events"] }
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

function WlsViewer(props: FileViewerProps) {
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

  const append = (kind: ConsoleEntry["kind"], text: string) => {
    setEntries((prev) => {
      const next = [...prev, { id: ++entrySeq, kind, text }]
      return next.length > MAX_CONSOLE_ENTRIES ? next.slice(next.length - MAX_CONSOLE_ENTRIES) : next
    })
  }

  const refreshText = async () => {
    try {
      const text = await props.readText()
      if (typeof text === "string") setCodeText(text)
    } catch {
      /* fall back to the host cache text already set */
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
    const target = codeRef.querySelector(`[data-line="${line}"]`)
    target?.scrollIntoView({ block: "center" })
  })

  const lines = () => codeText().split("\n")

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
      return await rpc.call<T>(method, input)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
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

  const statusLabel = () => {
    switch (status()) {
      case "unknown":
        return "idle"
      case "starting":
        return "starting kernel…"
      case "ready":
        return version() ? `ready (${version()})` : "ready"
      case "running":
        return "running…"
      case "paused":
        return pausedLine() !== undefined ? `paused at line ${pausedLine()}` : "paused"
      case "error":
        return "error"
      case "stopped":
        return "kernel stopped"
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
            Run
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={!isPaused()}
            onClick={() => void pausedCommand("continue")()}
          >
            Continue
          </Button>
          <Button size="small" variant="secondary" disabled={!isPaused()} onClick={() => void pausedCommand("step")()}>
            Step
          </Button>
          <Button size="small" variant="ghost" disabled={!isPaused()} onClick={() => void pausedCommand("abort")()}>
            Abort
          </Button>
          <Button size="small" variant="ghost" disabled={busy()} onClick={() => void restart()}>
            Restart
          </Button>
          <Button size="small" variant="ghost" onClick={() => void stop()}>
            Stop
          </Button>
          <Button size="small" variant="ghost" onClick={props.showSource}>
            Source
          </Button>
        </div>
      </header>

      <div class="oc-wls-body">
        <div class="oc-wls-code" ref={codeRef}>
          <For each={lines()}>
            {(line, index) => {
              const number = index() + 1
              return (
                <div class="oc-wls-line" data-line={number} classList={{ "is-paused": pausedLine() === number }}>
                  <button
                    type="button"
                    class="oc-wls-gutter"
                    classList={{ "has-breakpoint": breakpoints().includes(number) }}
                    title="toggle breakpoint"
                    onClick={() => toggleBreakpoint(number)}
                  >
                    <span class="oc-wls-line-number">{number}</span>
                    <span class="oc-wls-bp-dot" />
                  </button>
                  <pre class="oc-wls-line-text">{line === "" ? " " : line}</pre>
                </div>
              )
            }}
          </For>
        </div>

        <Show when={isPaused()}>
          <aside class="oc-wls-variables">
            <div class="oc-wls-variables-head">Variables (User` context)</div>
            <Show
              when={variables().length > 0}
              fallback={<div class="oc-wls-variables-empty">no variables defined yet</div>}
            >
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
            placeholder={
              isPaused() ? "evaluate an expression in the paused state" : "evaluate an expression in the kernel"
            }
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
    setBridge({ rpc: context.rpc, events: context.events })
    const registration = context.fileViewers.register({ id: "wls-repl", component: WlsViewer })
    return () => {
      registration.dispose()
      setBridge({})
    }
  },
})
