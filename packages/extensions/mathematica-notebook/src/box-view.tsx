import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Box, Preview } from "./preview-protocol"
import type { PreviewScheduler } from "./preview-scheduler"

function BoxView(props: { box: Box }) {
  const children = () => props.box.children ?? []
  const item = (i: number) => <BoxView box={children()[i] ?? { kind: "unknown", text: "Missing argument" }} />
  switch (props.box.kind) {
    case "text":
      return <mtext>{props.box.text}</mtext>
    case "unknown":
      return <mtext class="oc-nb-box-unknown">[{props.box.text}]</mtext>
    case "frac":
      return (
        <mfrac>
          {item(0)}
          {item(1)}
        </mfrac>
      )
    case "sup":
      return (
        <msup>
          {item(0)}
          {item(1)}
        </msup>
      )
    case "sub":
      return (
        <msub>
          {item(0)}
          {item(1)}
        </msub>
      )
    case "subsup":
      return (
        <msubsup>
          {item(0)}
          {item(1)}
          {item(2)}
        </msubsup>
      )
    case "sqrt":
      return <msqrt>{item(0)}</msqrt>
    case "root":
      return (
        <mroot>
          {item(0)}
          {item(1)}
        </mroot>
      )
    case "over":
      return (
        <mover>
          {item(0)}
          {item(1)}
        </mover>
      )
    case "under":
      return (
        <munder>
          {item(0)}
          {item(1)}
        </munder>
      )
    case "underover":
      return (
        <munderover>
          {item(0)}
          {item(1)}
          {item(2)}
        </munderover>
      )
    case "grid":
      return (
        <mtable columnalign="left">
          <For each={children()}>
            {(row) => (
              <mtr>
                <For each={row.children ?? [row]}>
                  {(cell) => (
                    <mtd>
                      <BoxView box={cell} />
                    </mtd>
                  )}
                </For>
              </mtr>
            )}
          </For>
        </mtable>
      )
    case "lines":
      return (
        <mtable columnalign="left" rowspacing="0.15em">
          <For each={children()}>
            {(line) => (
              <mtr>
                <mtd>
                  <BoxView box={line} />
                </mtd>
              </mtr>
            )}
          </For>
        </mtable>
      )
    case "style":
      return (
        <mstyle
          style={{
            "font-weight": props.box.style?.bold ? "bold" : undefined,
            "font-style": props.box.style?.italic ? "italic" : undefined,
            "font-size": props.box.style?.size ? `${props.box.style.size}px` : undefined,
          }}
        >
          <For each={children()}>{(box) => <BoxView box={box} />}</For>
        </mstyle>
      )
    default:
      return (
        <mrow>
          <For each={children()}>{(box) => <BoxView box={box} />}</For>
        </mrow>
      )
  }
}

export function RichCell(props: {
  index: number
  revision: string
  scheduler: PreviewScheduler
  source(signal: AbortSignal): Promise<{ text: string; total: number }>
  onEdit?(): void
}) {
  // Seed from the scheduler cache so a virtualizer remount repaints the
  // formula immediately instead of flashing the loading line.
  const [preview, setPreview] = createSignal<Preview | undefined>(props.scheduler.peek(props.index))
  const [error, setError] = createSignal("")
  const [source, setSource] = createSignal<{ text: string; total: number }>()
  const [open, setOpen] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  let alive = true
  let epoch = 0
  let sourceController: AbortController | undefined
  createEffect(() => {
    props.revision
    epoch++
    sourceController?.abort()
    setLoading(false)
    setPreview(props.scheduler.peek(props.index))
    setError("")
    setSource(undefined)
    setOpen(false)
    // Virtualizer already mounts only the viewport and its bounded buffer.
    // A second per-cell visibility observer races detached row measurement.
    const cancel = props.scheduler.request(props.index, (result) => {
      if (result instanceof Error) setError(result.message)
      else setPreview(result)
    })
    onCleanup(cancel)
  })
  onMount(() => {
    onCleanup(() => {
      alive = false
      epoch++
      sourceController?.abort()
    })
  })
  const loadSource = async () => {
    if (loading()) return
    const current = epoch
    sourceController = new AbortController()
    setLoading(true)
    try {
      const value = await props.source(sourceController.signal)
      if (alive && current === epoch) setSource(value)
    } catch (error) {
      if (alive && current === epoch) setError(String(error))
    } finally {
      if (alive && current === epoch) setLoading(false)
    }
  }
  return (
    <div class="oc-nb-rich" data-preview-status={preview()?.status ?? "loading"}>
      <Show when={preview()} fallback={<p class="oc-nb-muted">{error() || "Loading formula..."}</p>}>
        {(result) => (
          <>
            <div class="oc-nb-math-scroll">
              <math xmlns="http://www.w3.org/1998/Math/MathML" display="block">
                <BoxView box={result().box} />
              </math>
            </div>
            <Show when={result().status !== "complete"}>
              <p class="oc-nb-muted">{result().reasons.join("; ")}</p>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.onEdit}>
        <button type="button" class="oc-nb-edit" onClick={() => props.onEdit?.()}>
          Edit box source
        </button>
      </Show>
      <details
        class="oc-nb-opaque"
        open={open()}
        onToggle={(event) => {
          const active = event.currentTarget.open
          setOpen(active)
          if (active && !source()) void loadSource()
          if (!active) {
            sourceController?.abort()
            setSource(undefined)
          }
        }}
      >
        <summary>Preserved box source</summary>
        <Show when={open()}>
          <Show when={source()} fallback={<p class="oc-nb-muted">{error() || "Loading source..."}</p>}>
            {(value) => (
              <>
                <pre>{value().text}</pre>
                <Show when={value().total > value().text.length}>
                  <p class="oc-nb-muted">
                    Source excerpt ({value().text.length} of {value().total} characters). Use Source for the complete
                    notebook.
                  </p>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </details>
    </div>
  )
}
