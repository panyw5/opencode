import { createMemo, createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { defineWebExtension, type FileViewerProps } from "@opencode-ai/extension-kit/web"
import "./web.css"

type ViewerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; bytes: number }
  | { status: "error"; message: string }

function HelloViewer(props: FileViewerProps) {
  const [state, setState] = createSignal<ViewerState>({ status: "idle" })
  const lines = createMemo(() => (props.text() ?? "").split("\n"))

  const inspect = async () => {
    setState({ status: "loading" })
    try {
      const bytes = await props.readBytes()
      setState({ status: "ready", bytes: bytes.byteLength })
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

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
          <li>{line || " "}</li>
        ))}
      </ol>
    </section>
  )
}

function statusText(value: ViewerState) {
  if (value.status === "ready") return `${value.bytes} bytes`
  if (value.status === "error") return value.message
  return ""
}

export default defineWebExtension({
  id: "example.hello-viewer",
  apiVersion: 1,
  activate(context) {
    context.log.info("activating hello viewer")
    const registration = context.fileViewers.register({ id: "hello", component: HelloViewer })
    return () => registration.dispose()
  },
})
