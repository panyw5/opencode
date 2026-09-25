import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { Show, type JSX } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export interface ImagePreviewProps {
  src?: string
  alt?: string
  fallback?: JSX.Element
  fit?: "contain" | "width"
}

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  return (
    <div data-component="image-preview" data-fit={props.fit ?? "contain"}>
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div data-slot="image-preview-body">
            <Show when={props.src} fallback={props.fallback}>
              {(src) => <img src={src()} alt={props.alt ?? i18n.t("ui.imagePreview.alt")} data-slot="image-preview-image" />}
            </Show>
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
