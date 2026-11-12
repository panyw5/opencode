import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { defineWebExtension, type ExtensionContext, type FileViewerProps } from "@opencode-ai/extension-kit/web"
import { rpc, type Contract } from "./contract"
import type { RpcContractOutput } from "@opencode-ai/extension-kit/rpc"
import "./web.css"

const EXTENSION_ID = "example.hello-viewer"
const GREETING_EVENT = `${EXTENSION_ID}/greeting`

// The typed caller bound to the host bridge; see contract.ts for the shared
// contract between this web part and the server part.
type HelloCall = ReturnType<typeof rpc.bind>
type Bridge = { rpc?: ExtensionContext["rpc"]; events?: ExtensionContext["events"] }

const [bridge, setBridge] = createSignal<Bridge>({})
const [log, setLog] = createSignal<string[]>([])
const [busy, setBusy] = createSignal<"echo" | "child" | "greet" | undefined>(undefined)

const stamp = () => new Date().toLocaleTimeString()

function appendLog(entry: string) {
  setLog((prev) => [...prev.slice(-19), `[${stamp()}] ${entry}`])
}

async function runRpc(label: string, run: (call: HelloCall) => Promise<string>) {
  const bridgeRpc = bridge().rpc
  if (!bridgeRpc) {
    appendLog(`${label}: RPC bridge not available in this host`)
    return
  }
  const call = rpc.bind(bridgeRpc)
  setBusy(label === "echo" ? "echo" : label === "greet" ? "greet" : "child")
  try {
    appendLog(`${label}: ${await run(call)}`)
  } catch (error) {
    appendLog(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    setBusy(undefined)
  }
}

type ViewerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; bytes: number }
  | { status: "error"; message: string }

function HelloViewer(props: FileViewerProps) {
  const [state, setState] = createSignal<ViewerState>({ status: "idle" })
  const lines = createMemo(() => (props.text() ?? "").split("\n"))
  const rpcAvailable = createMemo(() => bridge().rpc !== undefined)

  const inspect = async () => {
    setState({ status: "loading" })
    try {
      const bytes = await props.readBytes()
      setState({ status: "ready", bytes: bytes.byteLength })
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  const echo = () =>
    void runRpc("echo", async (call) => {
      const result = await call("echo", { message: `hello from web (${props.file.path})` })
      return JSON.stringify(result)
    })

  const childPing = () =>
    void runRpc("child", async (call) => {
      await call("child.start")
      try {
        const ping = await call("child.ping", { text: `ping (${props.file.name})` })
        return JSON.stringify(ping)
      } finally {
        await call("child.stop")
      }
    })

  const greet = () =>
    void runRpc("greet", async (call) => {
      const result = await call("greet", { message: `greet me (${props.file.name})` })
      return `server emitted event: ${JSON.stringify(result)}`
    })

  return (
    <section class="oc-hello-viewer-root">
      <header class="oc-hello-viewer-header">
        <div>
          <div class="oc-hello-viewer-title">Hello Viewer</div>
          <div class="oc-hello-viewer-path">{props.file.path}</div>
        </div>
        <div class="oc-hello-viewer-actions">
          <Button size="small" variant="secondary" onClick={() => void inspect()}>
            Inspect bytes
          </Button>
          <Button size="small" variant="ghost" onClick={props.showSource}>
            Source
          </Button>
        </div>
      </header>

      <Show when={state().status !== "idle"}>
        <div class="oc-hello-viewer-status">
          <Show when={state().status === "loading"} fallback={statusText(state())}>
            <Spinner class="oc-hello-viewer-spinner" />
            Reading exact bytes…
          </Show>
        </div>
      </Show>

      <ol class="oc-hello-viewer-lines">
        {lines().map((line) => (
          <li>{line || " "}</li>
        ))}
      </ol>

      <footer class="oc-hello-viewer-console">
        <div class="oc-hello-viewer-console-head">
          <span class="oc-hello-viewer-title">Server bridge</span>
          <span
            class="oc-hello-viewer-bridge-state"
            classList={{ "is-on": rpcAvailable() }}
            title={rpcAvailable() ? "ctx.rpc / ctx.events available" : "host did not provide the RPC bridge yet"}
          >
            {rpcAvailable() ? "rpc: on" : "rpc: off"}
          </span>
        </div>
        <div class="oc-hello-viewer-console-actions">
          <Button size="small" variant="secondary" disabled={!rpcAvailable() || busy() !== undefined} onClick={echo}>
            Echo RPC
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={!rpcAvailable() || busy() !== undefined}
            onClick={childPing}
          >
            Child ping
          </Button>
          <Button size="small" variant="secondary" disabled={!rpcAvailable() || busy() !== undefined} onClick={greet}>
            Greet (event)
          </Button>
        </div>
        <Show
          when={rpcAvailable()}
          fallback={<div class="oc-hello-viewer-log">Server bridge not provided by this host; viewer-only mode.</div>}
        >
          <ul class="oc-hello-viewer-log">
            <For each={log()}>{(entry) => <li>{entry}</li>}</For>
          </ul>
        </Show>
      </footer>
    </section>
  )
}

function statusText(value: ViewerState) {
  if (value.status === "ready") return `${value.bytes} bytes`
  if (value.status === "error") return value.message
  return ""
}

export default defineWebExtension({
  id: EXTENSION_ID,
  apiVersion: 1,
  activate(context: ExtensionContext) {
    context.log.info("activating hello viewer")
    const offGreeting = context.events.on(GREETING_EVENT, (data) => {
      // The event payload mirrors the `greet` output shape from the contract.
      const payload =
        data && typeof data === "object" ? (data as Partial<RpcContractOutput<Contract, "greet">>) : undefined
      appendLog(`event ${GREETING_EVENT}: ${payload?.message ?? JSON.stringify(data)}`)
    })
    setBridge({ rpc: context.rpc, events: context.events })

    const registration = context.fileViewers.register({ id: "hello", component: HelloViewer })
    return () => {
      registration.dispose()
      offGreeting.dispose()
      setBridge({})
      setLog([])
    }
  },
})
