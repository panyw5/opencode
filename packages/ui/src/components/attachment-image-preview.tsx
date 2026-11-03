import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"
import { Button } from "./button"
import { IconButton } from "./icon-button"
import { ImagePreview } from "./image-preview"

export function AttachmentImagePreview(props: { src: string; filename: string }) {
  const i18n = useI18n()
  const [state, setState] = createStore({ zoom: 1 })
  let drag: { id: number; x: number; y: number; left: number; top: number } | undefined

  onMount(() => console.debug(`[image-preview] opened filename=${props.filename}`))
  onCleanup(() => console.debug(`[image-preview] closed filename=${props.filename}`))

  const zoom = (value: number) => {
    const next = Math.min(4, Math.max(0.25, value))
    console.debug(`[image-preview] zoom filename=${props.filename} from=${state.zoom} to=${next}`)
    setState("zoom", next)
  }
  const save = () => {
    console.debug(`[image-preview] save requested filename=${props.filename}`)
    const link = document.createElement("a")
    link.href = props.src
    link.download = props.filename
    document.body.append(link)
    link.click()
    link.remove()
  }
  const end = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (drag?.id !== event.pointerId) return
    drag = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    console.debug(`[image-preview] pan ended filename=${props.filename}`)
  }

  return (
    <ImagePreview
      src={props.src}
      alt={props.filename}
      zoom={state.zoom}
      toolbar={
        <>
          <span class="min-w-0 flex-1 truncate px-2 text-12-regular text-text-weak" title={props.filename}>
            {props.filename}
          </span>
          <IconButton
            icon="minus"
            variant="ghost"
            data-action="image-preview-zoom-out"
            aria-label={i18n.t("ui.imagePreview.zoomOut")}
            title={i18n.t("ui.imagePreview.zoomOut")}
            disabled={state.zoom <= 0.25}
            onClick={() => zoom(state.zoom - 0.25)}
          />
          <Button
            variant="ghost"
            size="small"
            class="shrink-0 tabular-nums"
            data-action="image-preview-reset"
            aria-label={i18n.t("ui.imagePreview.reset")}
            title={i18n.t("ui.imagePreview.reset")}
            onClick={() => zoom(1)}
          >
            {Math.round(state.zoom * 100)}%
          </Button>
          <IconButton
            icon="plus"
            variant="ghost"
            data-action="image-preview-zoom-in"
            aria-label={i18n.t("ui.imagePreview.zoomIn")}
            title={i18n.t("ui.imagePreview.zoomIn")}
            disabled={state.zoom >= 4}
            onClick={() => zoom(state.zoom + 0.25)}
          />
          <Button icon="download" variant="secondary" size="small" data-action="image-preview-save" onClick={save}>
            {i18n.t("ui.imagePreview.save")}
          </Button>
        </>
      }
      onWheel={(event) => {
        if (!event.deltaY) return
        event.preventDefault()
        zoom(state.zoom + (event.deltaY < 0 ? 0.25 : -0.25))
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const target = event.currentTarget
        drag = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: target.scrollLeft,
          top: target.scrollTop,
        }
        target.setPointerCapture(event.pointerId)
        console.debug(`[image-preview] pan started filename=${props.filename}`)
      }}
      onPointerMove={(event) => {
        if (drag?.id !== event.pointerId) return
        event.preventDefault()
        event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x)
        event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y)
      }}
      onPointerUp={end}
      onPointerCancel={end}
    />
  )
}
