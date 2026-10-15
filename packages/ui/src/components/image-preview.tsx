import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Show, type JSX } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export interface ImagePreviewProps {
  src?: string
  alt?: string
  fallback?: JSX.Element
  fit?: "contain" | "width"
  zoom?: number
  toolbar?: JSX.Element
  onWheel?: JSX.EventHandler<HTMLDivElement, WheelEvent>
  onPointerDown?: JSX.EventHandler<HTMLDivElement, PointerEvent>
  onPointerMove?: JSX.EventHandler<HTMLDivElement, PointerEvent>
  onPointerUp?: JSX.EventHandler<HTMLDivElement, PointerEvent>
  onPointerCancel?: JSX.EventHandler<HTMLDivElement, PointerEvent>
}

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  return (
    <div
      data-component="image-preview"
      data-fit={props.fit ?? "contain"}
      data-zoomable={props.zoom !== undefined ? "true" : undefined}
      data-zoom={props.zoom}
    >
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            {props.toolbar}
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div
            data-slot="image-preview-body"
            tabIndex={props.zoom !== undefined ? 0 : undefined}
            onWheel={props.onWheel}
            onPointerDown={props.onPointerDown}
            onPointerMove={props.onPointerMove}
            onPointerUp={props.onPointerUp}
            onPointerCancel={props.onPointerCancel}
            onDragStart={(event) => event.preventDefault()}
          >
            <Show when={props.src} fallback={props.fallback}>
              {(src) => (
                <Show
                  when={props.zoom !== undefined}
                  fallback={
                    <img
                      src={src()}
                      alt={props.alt ?? i18n.t("ui.imagePreview.alt")}
                      data-slot="image-preview-image"
                      draggable={false}
                    />
                  }
                >
                  <div
                    data-slot="image-preview-canvas"
                    style={{
                      width: `${(props.zoom ?? 1) * 100}%`,
                      height: props.fit === "width" ? "auto" : `${(props.zoom ?? 1) * 100}%`,
                    }}
                  >
                    <img
                      src={src()}
                      alt={props.alt ?? i18n.t("ui.imagePreview.alt")}
                      data-slot="image-preview-image"
                      draggable={false}
                    />
                  </div>
                </Show>
              )}
            </Show>
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
