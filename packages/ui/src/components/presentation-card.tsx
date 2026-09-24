import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { JSX } from "solid-js"
import type { PresentationVariant } from "../context/data"
import { useData } from "../context"
import { useDialog } from "../context/dialog"
import { useI18n } from "../context/i18n"
import { ImagePreview } from "./image-preview"
import { Button } from "./button"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { Spinner } from "./spinner"

export type PresentationMetadata = {
  artifactID: string
  mime: string
  width?: number
  height?: number
  filename: string
  size?: number
  sourcePath: string
  purpose: "result" | "verification" | "diagram"
  caption?: string
}

export interface PresentationCardProps {
  sessionID: string
  metadata?: Partial<PresentationMetadata> & { presentation?: Partial<PresentationMetadata> }
  input?: Record<string, unknown>
  status?: string
  error?: string
}

const IMAGE_MIME = /^(image\/(?:png|jpe?g|webp|gif|svg\+xml))$/i

export function formatPresentationSize(bytes: number | undefined, locale: string): string | undefined {
  if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) return undefined
  if (bytes < 1024) return `${new Intl.NumberFormat(locale).format(bytes)} B`
  const units = ["KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1)
  const value = bytes / 1024 ** (index + 1)
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${units[index]}`
}

function pendingFilename(input: PresentationCardProps["input"]): string | undefined {
  const value = input?.filename ?? input?.filePath
  if (typeof value !== "string") return undefined
  return value.split(/[\\/]/).filter(Boolean).at(-1)
}

export function presentationRequestIsCurrent(input: {
  aborted: boolean
  requestedArtifactID: string
  currentArtifactID?: string
}) {
  return !input.aborted && input.requestedArtifactID === input.currentArtifactID
}

export function readPresentationMetadata(metadata: PresentationCardProps["metadata"]): PresentationMetadata | undefined {
  const value = metadata?.presentation ?? metadata
  if (!value || typeof value.artifactID !== "string" || typeof value.mime !== "string") return undefined
  if (!IMAGE_MIME.test(value.mime)) return undefined
  return {
    artifactID: value.artifactID,
    mime: value.mime,
    width: typeof value.width === "number" && value.width > 0 ? value.width : undefined,
    height: typeof value.height === "number" && value.height > 0 ? value.height : undefined,
    filename: value.filename || "Presented file",
    size: typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : undefined,
    sourcePath: value.sourcePath || "",
    purpose: value.purpose ?? "result",
    caption: value.caption,
  }
}

function OriginalPreview(props: { sessionID: string; metadata: PresentationMetadata }): JSX.Element {
  const data = useData()
  const i18n = useI18n()
  const [url, setUrl] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  let controller: AbortController | undefined
  onMount(() => {
    if (!data.loadPresentation) return
    controller = new AbortController()
    console.debug(`[presentation] original load start session=${props.sessionID} artifact=${props.metadata.artifactID}`)
    void data.loadPresentation({ sessionID: props.sessionID, artifactID: props.metadata.artifactID, variant: "original", signal: controller.signal }).then((blob) => {
      if (!controller?.signal.aborted) {
        console.debug(`[presentation] original load success session=${props.sessionID} artifact=${props.metadata.artifactID} bytes=${blob.size}`)
        setUrl(URL.createObjectURL(blob))
      }
    }).catch((reason) => {
      if (!controller?.signal.aborted) {
        const message = reason instanceof Error ? reason.message : i18n.t("ui.presentation.loadError")
        console.warn(`[presentation] original load failed session=${props.sessionID} artifact=${props.metadata.artifactID} error=${message}`)
        setError(message)
      }
    })
  })
  onCleanup(() => {
    controller?.abort()
    const current = url()
    if (current) URL.revokeObjectURL(current)
  })
  return (
    <ImagePreview
      src={url()}
      alt={props.metadata.filename}
      fallback={<div class="presentation-card__lightbox-placeholder"><Show when={!error()} fallback={error()}><Spinner /></Show></div>}
    />
  )
}

export function PresentationCard(props: PresentationCardProps): JSX.Element {
  const data = useData()
  const dialog = useDialog()
  const i18n = useI18n()
  const [url, setUrl] = createSignal<string>()
  const [loadError, setLoadError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [loadedVariant, setLoadedVariant] = createSignal<PresentationVariant>()
  const metadata = () => readPresentationMetadata(props.metadata)
  let controller: AbortController | undefined
  let rootRef: HTMLElement | undefined
  let activeArtifactID: string | undefined

  const load = async (variant: PresentationVariant = "thumbnail") => {
    const value = metadata()
    if (!value || !data.loadPresentation || (url() && (variant === "thumbnail" || loadedVariant() === "original")) || loading()) return
    controller?.abort()
    const request = new AbortController()
    controller = request
    setLoading(true)
    setLoadError(undefined)
    try {
      const blob = await data.loadPresentation({
        sessionID: props.sessionID,
        artifactID: value.artifactID,
        variant,
        signal: request.signal,
      })
      if (!presentationRequestIsCurrent({
        aborted: request.signal.aborted,
        requestedArtifactID: value.artifactID,
        currentArtifactID: metadata()?.artifactID,
      })) return
      const next = URL.createObjectURL(blob)
      const previous = url()
      if (previous) URL.revokeObjectURL(previous)
      setUrl(next)
      setLoadedVariant(variant)
    } catch (error) {
      if (presentationRequestIsCurrent({
        aborted: request.signal.aborted,
        requestedArtifactID: value.artifactID,
        currentArtifactID: metadata()?.artifactID,
      })) {
        setLoadError(error instanceof Error ? error.message : i18n.t("ui.presentation.loadError"))
      }
    } finally {
      if (controller === request) {
        controller = undefined
        setLoading(false)
      }
    }
  }

  createEffect(() => {
    const artifactID = metadata()?.artifactID
    if (artifactID !== activeArtifactID) {
      controller?.abort()
      const current = url()
      if (current) URL.revokeObjectURL(current)
      setUrl(undefined)
      setLoadedVariant(undefined)
      setLoadError(undefined)
      setLoading(false)
      activeArtifactID = artifactID
    }
    if (!rootRef || !artifactID || !data.loadPresentation) return
    if (typeof IntersectionObserver === "undefined") {
      void load()
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void load()
        observer.disconnect()
      }
    }, { rootMargin: "320px" })
    observer.observe(rootRef)
    onCleanup(() => observer.disconnect())
  })

  onCleanup(() => {
    controller?.abort()
    const current = url()
    if (current) URL.revokeObjectURL(current)
  })

  const openPreview = async () => {
    const value = metadata()
    if (!value) return
    console.debug(`[presentation] original open session=${props.sessionID} artifact=${value.artifactID}`)
    dialog.show(() => <OriginalPreview sessionID={props.sessionID} metadata={value} />)
  }

  const openSource = () => {
    const value = metadata()
    if (!value?.sourcePath) return
    data.openPresentationSource?.({ sessionID: props.sessionID, path: value.sourcePath })
  }

  const state = () => props.status === "error" || !!props.error || !!loadError() ? "error" : props.status === "pending" || props.status === "running" ? "pending" : "ready"
  const ratio = () => {
    const value = metadata()
    if (!value?.width || !value.height) return "16 / 9"
    return `${Math.max(1, Math.min(4, value.width / value.height))}`
  }

  return (
    <article
      ref={rootRef}
      class="presentation-card"
      data-component="presentation-card"
      data-presentation-artifact={metadata()?.artifactID}
      data-presentation-state={state()}
    >
      <Show when={metadata()?.sourcePath && !!data.openPresentationSource}>
        <button
          type="button"
          class="presentation-card__open"
          aria-label={`${i18n.t("ui.presentation.openPreview")} ${metadata()?.filename ?? i18n.t("ui.presentation.file")}`}
          onClick={openSource}
        />
      </Show>
      <div class="presentation-card__preview" style={{ "aspect-ratio": ratio() }}>
        <Show when={url()} fallback={<div class="presentation-card__placeholder" aria-hidden="true"><Show when={loading() || state() === "pending"} fallback={<Icon name={state() === "error" ? "circle-x" : "file"} size="large" />}><Spinner /></Show></div>}>
          {(src) => <img src={src()} alt={metadata()?.filename ?? "Presented file"} loading="lazy" decoding="async" />}
        </Show>
      </div>
      <Show when={state() === "ready" && !!url()}>
        <IconButton
          icon="expand"
          class="presentation-card__zoom"
          variant="secondary"
          aria-label={`${i18n.t("ui.presentation.zoom")} ${metadata()?.filename ?? i18n.t("ui.presentation.file")}`}
          onClick={openPreview}
        />
      </Show>
      <div class="presentation-card__body">
        <div class="presentation-card__heading">
          <div class="presentation-card__file-line">
            <strong title={metadata()?.filename}>{metadata()?.filename ?? pendingFilename(props.input) ?? i18n.t("ui.presentation.file")}</strong>
            <Show when={formatPresentationSize(metadata()?.size, i18n.locale())}>
              {(size) => <span class="presentation-card__size">{size()}</span>}
            </Show>
          </div>
          <Show when={metadata()?.caption}><span class="presentation-card__caption">{metadata()!.caption}</span></Show>
          <Show when={loadError() || props.error}><span class="presentation-card__error">{loadError() ?? props.error}</span></Show>
        </div>
        <div class="presentation-card__actions">
          <Show when={!!loadError()}>
            <Button class="presentation-card__retry" size="small" variant="secondary" onClick={() => void load()}>{i18n.t("ui.presentation.retry")}</Button>
          </Show>
        </div>
      </div>
    </article>
  )
}
