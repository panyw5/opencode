import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import type { ImageAttachmentPart } from "@/context/prompt"
import { useLanguage } from "@/context/language"

export function PromptImagePreview(props: { attachment: ImageAttachmentPart }) {
  const language = useLanguage()
  const [state, setState] = createStore({ zoom: 1 })
  let drag: { id: number; x: number; y: number; left: number; top: number } | undefined

  onMount(() => console.debug(`[prompt-image-preview] opened id=${props.attachment.id}`))
  onCleanup(() => console.debug(`[prompt-image-preview] closed id=${props.attachment.id}`))

  const zoom = (value: number) => {
    const next = Math.min(4, Math.max(0.25, value))
    console.debug(`[prompt-image-preview] zoom id=${props.attachment.id} from=${state.zoom} to=${next}`)
    setState("zoom", next)
  }
  const save = () => {
    console.debug(`[prompt-image-preview] save requested id=${props.attachment.id} mime=${props.attachment.mime}`)
    const link = document.createElement("a")
    link.href = props.attachment.dataUrl
    link.download = props.attachment.filename
    document.body.append(link)
    link.click()
    link.remove()
  }
  const end = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (drag?.id !== event.pointerId) return
    drag = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    console.debug(`[prompt-image-preview] pan ended id=${props.attachment.id}`)
  }

  return (
    <ImagePreview
      src={props.attachment.dataUrl}
      alt={props.attachment.filename}
      zoom={state.zoom}
      toolbar={
        <>
          <span class="min-w-0 flex-1 truncate px-2 text-12-regular text-text-weak" title={props.attachment.filename}>
            {props.attachment.filename}
          </span>
          <IconButton
            icon="minus"
            variant="ghost"
            data-action="image-preview-zoom-out"
            aria-label={language.t("prompt.imagePreview.zoomOut")}
            title={language.t("prompt.imagePreview.zoomOut")}
            disabled={state.zoom <= 0.25}
            onClick={() => zoom(state.zoom - 0.25)}
          />
          <Button
            variant="ghost"
            size="small"
            class="shrink-0 tabular-nums"
            data-action="image-preview-reset"
            aria-label={language.t("prompt.imagePreview.reset")}
            title={language.t("prompt.imagePreview.reset")}
            onClick={() => zoom(1)}
          >
            {Math.round(state.zoom * 100)}%
          </Button>
          <IconButton
            icon="plus"
            variant="ghost"
            data-action="image-preview-zoom-in"
            aria-label={language.t("prompt.imagePreview.zoomIn")}
            title={language.t("prompt.imagePreview.zoomIn")}
            disabled={state.zoom >= 4}
            onClick={() => zoom(state.zoom + 0.25)}
          />
          <Button icon="download" variant="secondary" size="small" data-action="image-preview-save" onClick={save}>
            {language.t("common.save")}
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
        console.debug(`[prompt-image-preview] pan started id=${props.attachment.id}`)
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
