import { createEffect, Show } from "solid-js"
import { Dialog } from "./dialog"
import { FileMedia } from "./file-media"
import { Markdown } from "./markdown"
import { Spinner } from "./spinner"
import type { AttachmentPreviewState } from "./gpt-pro-tool"
import { useDialog } from "../context/dialog"
import { useI18n } from "../context/i18n"

function decodePreviewText(base64: string) {
  try {
    const binary = atob(base64)
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
  } catch {
    return undefined
  }
}

function textMime(mime: string) {
  return mime.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(mime)
}

function markdownMime(mime: string, name: string) {
  return mime === "text/markdown" || /\.md$/i.test(name)
}

function tableMime(mime: string) {
  return mime === "text/csv" || mime === "text/tab-separated-values"
}

function previewPath(name: string, mime: string) {
  const extensions: Record<string, string> = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "text/markdown": "md",
    "text/plain": "txt",
  }
  const extension = extensions[mime.toLowerCase()]
  if (!extension) return name
  return `${name.replace(/\.[^.]*$/, "")}.${extension}`
}

export function AttachmentPreviewDialog(props: { state: AttachmentPreviewState; onClose: () => void }) {
  const dialog = useDialog()
  const t = useI18n().t
  const file = () => props.state.file
  const text = () => {
    const current = file()
    if (!current || !textMime(current.mime)) return
    return decodePreviewText(current.base64)
  }
  let opened = false
  createEffect(() => {
    if (!props.state.open || opened) return
    opened = true
    dialog.show(
      () => (
        <Dialog
          title={file()?.name ?? t("ui.tool.gptPro.attachment.previewTitle")}
          size="x-large"
          class="h-full"
          containerStyle={{ width: "min(calc(100vw - 32px), 960px)", height: "min(calc(100vh - 32px), 680px)" }}
        >
          <div class="gpt-pro-attachment-preview" data-testid="gpt-pro-attachment-preview">
            <Show when={props.state.loading}>
              <div class="flex min-h-40 items-center justify-center gap-2 text-13-regular text-text-weak">
                <Spinner />
                {t("ui.tool.gptPro.attachment.previewLoading")}
              </div>
            </Show>
            <Show when={props.state.error}>
              <p class="p-4 text-13-regular text-text-critical-base" role="alert">
                {props.state.error}
              </p>
            </Show>
            <Show when={file()}>
              {(current) =>
                text() !== undefined ? (
                  tableMime(current().mime) ? (
                    <FileMedia
                      media={{
                        path: previewPath(current().name, current().mime),
                        current: { type: "text", content: text()!, mimeType: current().mime },
                      }}
                      fallback={() => (
                        <div class="flex min-h-40 items-center justify-center p-4 text-13-regular text-text-weak">
                          {t("ui.tool.gptPro.attachment.previewUnavailable")}
                        </div>
                      )}
                    />
                  ) : markdownMime(current().mime, current().name) ? (
                    <div class="gpt-pro-attachment-preview__text">
                      <Markdown text={text()!} cacheKey={`gpt-pro-preview-${current().name}`} fileLinks={false} />
                    </div>
                  ) : (
                    <pre class="gpt-pro-attachment-preview__plain">{text()}</pre>
                  )
                ) : (
                  <FileMedia
                    media={{
                      path: previewPath(current().name, current().mime),
                      current: {
                        type: "binary",
                        content: current().base64,
                        encoding: "base64",
                        mimeType: current().mime,
                      },
                    }}
                    fallback={() => (
                      <div class="flex min-h-40 items-center justify-center p-4 text-13-regular text-text-weak">
                        {t("ui.tool.gptPro.attachment.previewUnavailable")}
                      </div>
                    )}
                  />
                )
              }
            </Show>
          </div>
        </Dialog>
      ),
      props.onClose,
    )
  })
  return null
}
