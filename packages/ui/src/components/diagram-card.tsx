import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useDialog } from "../context/dialog"
import { useI18n } from "../context/i18n"
import { Button } from "./button"
import { IconButton } from "./icon-button"
import { ImagePreview } from "./image-preview"
import { Spinner } from "./spinner"
import {
  currentDiagramPalette,
  renderDiagramSvg,
  svgAspectRatio,
  themeSvgSource,
  type DiagramSyntax,
} from "./diagram-render"

type DiagramMetadata = {
  id: string
  syntax: DiagramSyntax
  title: string
  caption?: string
  bytes: number
}

export type DiagramCardProps = {
  sessionID: string
  partID: string
  status: string
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  error?: string
}

export function readDiagramMetadata(input: DiagramCardProps["input"], metadata: DiagramCardProps["metadata"]) {
  const value = metadata.diagram
  if (!value || typeof value !== "object") return
  const item = value as Partial<DiagramMetadata>
  if (typeof item.id !== "string" || (item.syntax !== "svg" && item.syntax !== "mermaid")) return
  if (typeof input.source !== "string" || !input.source.trim()) return
  return {
    id: item.id,
    syntax: item.syntax,
    source: input.source.trim(),
    title: typeof item.title === "string" ? item.title : "Diagram",
    caption: typeof item.caption === "string" ? item.caption : undefined,
  }
}

function DiagramLightbox(props: { svg: string; title: string; tall: boolean }): JSX.Element {
  const url = URL.createObjectURL(new Blob([props.svg], { type: "image/svg+xml" }))
  onCleanup(() => URL.revokeObjectURL(url))
  return <ImagePreview src={url} alt={props.title} fit={props.tall ? "width" : "contain"} />
}

export function DiagramCard(props: DiagramCardProps): JSX.Element {
  const dialog = useDialog()
  const i18n = useI18n()
  const [url, setUrl] = createSignal<string>()
  const [svg, setSvg] = createSignal<string>()
  const [renderError, setRenderError] = createSignal<string>()
  const [rendering, setRendering] = createSignal(false)
  const [tall, setTall] = createSignal(false)
  const [palette, setPalette] = createSignal(currentDiagramPalette())
  const diagram = () => readDiagramMetadata(props.input, props.metadata)
  let element: HTMLElement | undefined
  let activeID: string | undefined
  let generation = 0

  onMount(() => {
    const observer = new MutationObserver(() => setPalette(currentDiagramPalette()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-color-scheme", "data-theme"],
    })
    onCleanup(() => observer.disconnect())
  })

  const render = async () => {
    const value = diagram()
    if (!value || props.status !== "completed" || rendering() || svg()) return
    const run = generation
    setRendering(true)
    setRenderError(undefined)
    console.debug(`[diagram] render start session=${props.sessionID} part=${props.partID} syntax=${value.syntax}`)
    try {
      const colors = palette()
      const source = await renderDiagramSvg({ ...value, palette: colors })
      const rendered = value.syntax === "svg" ? themeSvgSource(source, colors) : source
      if (run !== generation) return
      const next = URL.createObjectURL(new Blob([rendered], { type: "image/svg+xml" }))
      const previous = url()
      if (previous) URL.revokeObjectURL(previous)
      setTall((svgAspectRatio(rendered) ?? 1) < 0.5)
      setSvg(rendered)
      setUrl(next)
      console.debug(`[diagram] render success session=${props.sessionID} part=${props.partID} bytes=${rendered.length}`)
    } catch (error) {
      if (run !== generation) return
      const message = error instanceof Error ? error.message : i18n.t("ui.diagram.renderError")
      setRenderError(message)
      console.warn(`[diagram] render failed session=${props.sessionID} part=${props.partID} error=${message}`)
    } finally {
      if (run === generation) setRendering(false)
    }
  }

  createEffect(() => {
    const id = diagram()?.id ? `${palette().key}:${diagram()!.id}` : undefined
    if (id !== activeID) {
      generation++
      const previous = url()
      if (previous) URL.revokeObjectURL(previous)
      setUrl(undefined)
      setSvg(undefined)
      setRenderError(undefined)
      setRendering(false)
      setTall(false)
      activeID = id
    }
    if (!id || !element || props.status !== "completed") return
    if (typeof IntersectionObserver === "undefined") {
      void render()
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void render()
      },
      { rootMargin: "320px" },
    )
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  onCleanup(() => {
    generation++
    const current = url()
    if (current) URL.revokeObjectURL(current)
  })

  const open = () => {
    const content = svg()
    if (!content) return
    console.debug(`[diagram] zoom open session=${props.sessionID} part=${props.partID}`)
    dialog.show(() => (
      <DiagramLightbox svg={content} title={diagram()?.title ?? i18n.t("ui.diagram.title")} tall={tall()} />
    ))
  }

  const imageError = (event: Event & { currentTarget: HTMLImageElement }) => {
    const current = url()
    if (!current || event.currentTarget.src !== current) return
    URL.revokeObjectURL(current)
    setUrl(undefined)
    setSvg(undefined)
    setRenderError(i18n.t("ui.diagram.renderError"))
    console.warn(`[diagram] image decode failed session=${props.sessionID} part=${props.partID}`)
  }

  const state = () =>
    props.status === "error" || !!props.error || !!renderError() ? "error" : svg() ? "ready" : "pending"
  const title = () =>
    diagram()?.title ?? (typeof props.input.title === "string" ? props.input.title : i18n.t("ui.diagram.title"))

  return (
    <article
      ref={element}
      class="diagram-card"
      data-component="diagram-card"
      data-diagram-state={state()}
      data-diagram-syntax={diagram()?.syntax}
      data-diagram-layout={tall() ? "tall" : "normal"}
    >
      <div
        class="diagram-card__preview"
        data-scrollable
        role="region"
        aria-label={title()}
        tabIndex={tall() ? 0 : undefined}
      >
        <Show
          when={url()}
          fallback={
            <div class="diagram-card__placeholder">
              <Show when={renderError() || props.error} fallback={<Spinner />}>
                {renderError() ?? props.error}
              </Show>
            </div>
          }
        >
          {(src) => (
            <img
              src={src()}
              alt={title()}
              loading="lazy"
              decoding="async"
              onLoad={(event) =>
                console.debug(
                  `[diagram] image loaded session=${props.sessionID} part=${props.partID} width=${event.currentTarget.naturalWidth} height=${event.currentTarget.naturalHeight}`,
                )
              }
              onError={imageError}
            />
          )}
        </Show>
      </div>
      <Show when={svg()}>
        <IconButton
          icon="expand"
          class="diagram-card__zoom"
          variant="secondary"
          aria-label={`${i18n.t("ui.presentation.zoom")} ${title()}`}
          onClick={open}
        />
      </Show>
      <div class="diagram-card__body">
        <div class="diagram-card__heading">
          <div class="diagram-card__title-row">
            <strong title={title()}>{title()}</strong>
            <Show when={diagram()?.syntax}>
              <span>{diagram()?.syntax === "svg" ? "SVG" : "Mermaid"}</span>
            </Show>
          </div>
          <Show when={diagram()?.caption}>
            <p>{diagram()?.caption}</p>
          </Show>
        </div>
        <Show when={!!renderError()}>
          <Button class="diagram-card__retry" size="small" variant="secondary" onClick={() => void render()}>
            {i18n.t("ui.presentation.retry")}
          </Button>
        </Show>
      </div>
    </article>
  )
}
