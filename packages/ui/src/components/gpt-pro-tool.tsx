import { createEffect, createMemo, createSignal, For, lazy, onCleanup, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { type GptProAPI } from "@opencode-ai/util/gpt-pro"
import { BasicTool } from "./basic-tool"
import { Button } from "./button"
import { FileIcon } from "./file-icon"
import { Spinner } from "./spinner"
import { handoffGptPro } from "./gpt-pro-handoff"
import { parseGptProOutputRecord, resolveGptProView, type GptProCachedResult } from "./gpt-pro-result"
import { gptProMarkdown } from "./gpt-pro-markdown"
import { Markdown } from "./markdown"
import { useI18n } from "../context/i18n"
import { GptProErrorNotice } from "./gpt-pro-error-notice"
import { gptProDiagnostic } from "@opencode-ai/util/gpt-pro-error"
import { gptProCapabilities, type GptProHistoricalSnapshot } from "@opencode-ai/util/gpt-pro-state"
import { gptProStateStore, useGptProConsultation } from "./gpt-pro-state"

const AttachmentPreviewDialog = lazy(() =>
  import("./gpt-pro-attachment-preview").then((module) => ({ default: module.AttachmentPreviewDialog })),
)
type Props = {
  client?: GptProAPI
  status?: string
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  output?: string
  error?: string
  part?: ToolPart
}
type AttachmentStatus = "pending" | "uploading" | "ready" | "failed" | "unknown"
type AttachmentView = {
  id: string
  attachmentID?: string
  name: string
  mime?: string
  status: AttachmentStatus
  error?: string
}
type AttachmentPreviewData = { name: string; mime: string; base64: string }
export type AttachmentPreviewState = {
  open: boolean
  loading: boolean
  error: string
  file?: AttachmentPreviewData
}
const desktopApi = () =>
  typeof window === "undefined" ? undefined : (window as unknown as { api?: { gptPro?: GptProAPI } }).api?.gptPro

const HISTORICAL_PHASES = new Set([
  "queued",
  "preparing",
  "sending",
  "generating",
  "completed",
  "paused",
  "cancelled",
  "failed",
  "interrupted",
  "send_uncertain",
  "pending",
  "running",
  "error",
])

function displayName(value: string) {
  let path = value
  if (/^file:\/\//i.test(value)) {
    try {
      path = decodeURIComponent(new URL(value).pathname)
    } catch {}
  }
  return path.split(/[\\/]/).filter(Boolean).at(-1) || ""
}

export function fallbackAttachmentViews(value: unknown, failed = false): AttachmentView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const raw =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? typeof (item as Record<string, unknown>).name === "string"
            ? String((item as Record<string, unknown>).name)
            : typeof (item as Record<string, unknown>).path === "string"
              ? String((item as Record<string, unknown>).path)
              : ""
          : ""
    const name = displayName(raw)
    if (!name) return []
    return [{ id: `fallback:${index}:${name}`, name, status: failed ? ("failed" as const) : ("unknown" as const) }]
  })
}

export function attachmentViews(value: unknown): AttachmentView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return []
    const attachment = item as Record<string, unknown>
    const rawName = typeof attachment.name === "string" ? attachment.name : ""
    // Names are display-only. Never expose the separately stored authorized path.
    const name = displayName(rawName) || `Attachment ${index + 1}`
    const attachmentID = typeof attachment.id === "string" ? attachment.id : undefined
    const rawStatus = attachment.status
    const status: AttachmentStatus =
      rawStatus === "pending" || rawStatus === "uploading" || rawStatus === "ready" || rawStatus === "failed"
        ? rawStatus
        : "unknown"
    let error = typeof attachment.error === "string" ? attachment.error.trim() : ""
    if (typeof attachment.path === "string" && attachment.path) error = error.split(attachment.path).join("")
    // Backend errors may contain local path details; strip them before display.
    error = error
      .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>]+/g, "")
      .replace(/\/(?:[^\s"'<>]+\/)*[^\s"'<>]+/g, "")
      .slice(0, 240)
    return [
      {
        id: attachmentID ?? `${index}:${name}`,
        attachmentID,
        name,
        mime: typeof attachment.mime === "string" ? attachment.mime : undefined,
        status,
        error: error || undefined,
      },
    ]
  })
}

export async function fetchGptProAttachmentPreview(
  client: Pick<GptProAPI, "attachmentPreview">,
  jobID: string,
  attachment: AttachmentView,
) {
  if (!attachment.attachmentID || !client.attachmentPreview) return
  return client.attachmentPreview({ id: jobID, attachmentID: attachment.attachmentID })
}

export function gptProPreviewJobID(currentJobID: string | undefined, originalJobID: string | undefined) {
  return currentJobID ?? originalJobID
}

export function isValidGptProAttachmentPreview(value: unknown): value is AttachmentPreviewData {
  if (!value || typeof value !== "object") return false
  const preview = value as Record<string, unknown>
  return typeof preview.name === "string" && typeof preview.mime === "string" && typeof preview.base64 === "string"
}

function previewPath(name: string, mime: string) {
  const extensions: Record<string, string> = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "text/markdown": "md",
    "text/plain": "txt",
    "text/csv": "csv",
    "text/tab-separated-values": "tsv",
    "application/json": "json",
  }
  const extension = extensions[mime.toLowerCase()]
  if (!extension) return name
  const base = name.replace(/\.[^.]*$/, "")
  return `${base}.${extension}`
}

export function GptProTool(props: Props) {
  const api = () => props.client ?? desktopApi()
  const t = useI18n().t
  const historical = createMemo<GptProHistoricalSnapshot>(() => ({
    kind: "historical",
    id: typeof props.metadata.consultation_id === "string" ? props.metadata.consultation_id : undefined,
    phase: String(props.metadata.phase ?? props.status ?? ""),
    error: gptProDiagnostic(props.error ?? props.metadata.error ?? ""),
    url: typeof props.metadata.url === "string" ? props.metadata.url : undefined,
  }))
  const id = createMemo(() => historical().id)
  const entry = useGptProConsultation(api, id)
  const execution = () => {
    const value = entry().state
    return value?.kind === "execution" ? value.job : undefined
  }
  const archive = () => {
    const value = entry().state
    return value?.kind === "archive" ? value.result : undefined
  }
  const capabilities = () => gptProCapabilities(entry().state, entry().freshness === "current" && !entry().pending)
  const resolvedID = () => execution()?.id ?? archive()?.id ?? id()
  const historyOnly = () => !api() || !id()
  const [state, set] = createStore({
    error: "",
    busy: false,
    historyOpen: !api() && !!id(),
    history: { loading: false, result: undefined as GptProCachedResult | undefined, error: "" },
    preview: { open: false, loading: false, error: "", file: undefined as AttachmentPreviewData | undefined },
  })
  const previewJobID = resolvedID
  let previewRequest = 0
  let historyRequest = 0
  const recorded = createMemo(() => {
    const jobID = id()
    return jobID ? parseGptProOutputRecord(props.output, jobID) : undefined
  })
  const recordedText = createMemo(() => {
    const record = recorded()
    return record ? gptProMarkdown(record.html, record.text) : ""
  })
  const historyText = createMemo(() => {
    const saved = state.history.result
    return recordedText() || (saved ? gptProMarkdown(saved.html, saved.text) : "")
  })
  const historicalPhaseLabel = () => {
    const value = historical().phase
    return value && HISTORICAL_PHASES.has(value) ? t(`ui.tool.gptPro.phase.${value}`) : value
  }
  const inFlight = () => ["queued", "preparing", "sending", "generating"].includes(phase())
  const historyToggle = () => historyOnly() || !inFlight() || !!recordedText() || !!historicalDiagnostic()
  const historicalDiagnostic = () =>
    gptProDiagnostic(
      props.error ??
        props.metadata.error ??
        historicalAttachments()
          .filter((item) => item.error)
          .map((item) => item.error)
          .join("\n"),
    )
  createEffect(() => {
    if (!state.historyOpen || state.history.loading || state.history.result || recordedText()) return
    const client = api()
    const jobID = resolvedID()
    if (!client || !jobID) return
    const request = ++historyRequest
    set("history", { loading: true, error: "", result: undefined })
    console.debug(`[gpt-pro-tool] history record resolving id=${jobID}`)
    void resolveGptProView(client, jobID, props.output)
      .then((resolution) => {
        if (request !== historyRequest) return
        if (resolution.kind === "cached") {
          console.debug(
            `[gpt-pro-tool] history record ready id=${resolution.result.id} source=${resolution.result.source}`,
          )
          set("history", { loading: false, result: resolution.result, error: "" })
          return
        }
        if (resolution.kind === "unavailable") {
          console.warn(`[gpt-pro-tool] history record unavailable id=${resolution.id}`)
          set("history", { loading: false, error: resolution.error ?? "" })
          return
        }
        set("history", { loading: false })
      })
      .catch((error) => {
        if (request !== historyRequest) return
        console.warn(`[gpt-pro-tool] history record failed id=${jobID} error=${String(error)}`)
        set("history", { loading: false, error: String(error) })
      })
  })
  const closePreview = () => {
    console.debug(`[gpt-pro-tool] attachment preview closed job=${previewJobID() ?? "unknown"}`)
    previewRequest++
    set("preview", { open: false, loading: false, error: "", file: undefined })
  }
  createEffect(() => {
    console.debug(
      `[gpt-pro-tool] state observed job=${id() ?? "unknown"} source=${entry().state?.kind ?? "historical"} freshness=${entry().freshness}`,
    )
  })
  onCleanup(() => {
    console.debug(
      `[gpt-pro-tool] tool cleanup job=${id() ?? "unknown"} previewOpen=${state.preview.open} previewLoading=${state.preview.loading}`,
    )
    previewRequest++
    historyRequest++
  })
  const phase = () => execution()?.phase ?? archive()?.phase ?? (historyOnly() ? (historical().phase ?? "") : "")
  const queueReason = () => execution()?.queueReason ?? (historyOnly() ? String(props.metadata.queue_reason ?? "") : "")
  const queueOwnerConsultationID = () =>
    execution()?.queueOwnerConsultationID ??
    (historyOnly() ? String(props.metadata.queue_owner_consultation_id ?? "") : "")
  const phaseLabel = () => {
    if (!phase())
      return t(entry().freshness === "loading" ? "ui.tool.gptPro.state.loading" : "ui.tool.gptPro.state.unavailable")
    if (phase() === "queued" && queueReason() === "login_import")
      return t("ui.tool.gptPro.error.login_import_pending.title")
    if (phase() === "queued" && queueReason() === "capacity") return t("ui.tool.gptPro.queueReason.capacity")
    if (phase() === "queued" && queueReason() === "page_capacity") return t("ui.tool.gptPro.queueReason.pageCapacity")
    if (phase() === "queued" && queueReason() === "owner_busy")
      return t("ui.tool.gptPro.queueReason.ownerBusy", { consultationID: queueOwnerConsultationID() })
    return t(`ui.tool.gptPro.phase.${phase()}`)
  }
  const status = () => {
    const current = phase()
    if (current === "completed") return "completed"
    if (["failed", "send_uncertain", "interrupted"].includes(current)) return "error"
    if (["queued", "preparing", "sending", "generating"].includes(current)) return "running"
    if (current === "paused" || current === "cancelled") return "pending"
    return props.status
  }
  const error = () =>
    String(
      state.error ||
        (!id() ? (props.error ?? "") : "") ||
        (entry().freshness === "current" ? (execution()?.error ?? "") : "") ||
        attachments()
          .filter((item) => item.error)
          .map((item) => `Attachment ${item.name}: ${item.error}`)
          .join("\n"),
    )
  const historicalAttachments = () => {
    const metadataAttachments = props.metadata.attachments
    if (Array.isArray(metadataAttachments) && metadataAttachments.length) return attachmentViews(metadataAttachments)
    const inputAttachments = attachmentViews(props.input.attachments)
    if (inputAttachments.length) return inputAttachments
    return fallbackAttachmentViews(props.input.files, props.status === "error")
  }
  const attachments = createMemo(() =>
    historyOnly() ? historicalAttachments() : attachmentViews(execution()?.attachments),
  )
  const command = async (
    action: "open" | "stop" | "pause" | "resume" | "intervene" | "status" | "background",
    prompt?: string,
  ) => {
    if (!id() || !api()) return
    set({ busy: true, error: "" })
    try {
      const job = await gptProStateStore(api()!).command({ action, id: resolvedID(), prompt })
      return job
    } catch (error) {
      console.warn(`[gpt-pro-tool] command failed action=${action} id=${resolvedID()} phase=${phase()}`)
      set("error", String(error))
    } finally {
      set("busy", false)
    }
  }
  const viewConversation = async () => {
    const client = api()
    const jobID = resolvedID()
    if (!client || !jobID) return
    set({ busy: true, error: "" })
    console.debug(`[gpt-pro-tool] view conversation page id=${jobID}`)
    try {
      await handoffGptPro(client, jobID)
    } catch (error) {
      console.warn(`[gpt-pro-tool] view conversation page failed id=${jobID} error=${String(error)}`)
      set("error", String(error))
    } finally {
      set("busy", false)
    }
  }
  const previewAttachment = async (attachment: AttachmentView) => {
    const client = api()
    const jobID = previewJobID()
    const attachmentID = attachment.attachmentID
    if (!client || !jobID || !client.attachmentPreview || !attachmentID) return
    const request = ++previewRequest
    set("preview", { open: true, loading: true, error: "", file: undefined })
    console.debug(`[gpt-pro-tool] attachment preview requested job=${jobID} attachment=${attachmentID}`)
    try {
      const result = await fetchGptProAttachmentPreview(client, jobID, attachment)
      if (request !== previewRequest) {
        console.debug(`[gpt-pro-tool] attachment preview result discarded job=${jobID} attachment=${attachmentID}`)
        return
      }
      if (!isValidGptProAttachmentPreview(result)) throw new Error("Preview unavailable")
      const padding = result.base64.endsWith("==") ? 2 : result.base64.endsWith("=") ? 1 : 0
      console.debug(
        `[gpt-pro-tool] attachment preview loaded job=${jobID} attachment=${attachmentID} mime=${result.mime} bytes=${Math.max(0, Math.floor((result.base64.length * 3) / 4) - padding)}`,
      )
      set("preview", {
        open: true,
        loading: false,
        error: "",
        file: { name: displayName(result.name) || attachment.name, mime: result.mime, base64: result.base64 },
      })
    } catch {
      if (request !== previewRequest) {
        console.debug(`[gpt-pro-tool] attachment preview error discarded job=${jobID} attachment=${attachmentID}`)
        return
      }
      console.warn(`[gpt-pro-tool] attachment preview unavailable job=${jobID} attachment=${attachmentID}`)
      set("preview", {
        open: true,
        loading: false,
        error: t("ui.tool.gptPro.attachment.previewUnavailable"),
        file: undefined,
      })
    }
  }
  const canPreview = (attachment: AttachmentView) =>
    !!previewJobID() && !!api()?.attachmentPreview && !!attachment.attachmentID
  return (
    <div
      data-component="gpt-pro-tool"
      data-job-id={id()}
      data-phase={phase()}
      data-state-source={entry().state?.kind ?? "historical"}
      data-freshness={entry().freshness}
    >
      <BasicTool
        icon="brain"
        status={status()}
        part={props.part}
        hideDetails
        showPendingMeta
        showPendingDetails
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <button
                type="button"
                data-slot="basic-tool-tool-title"
                class="tool-interact"
                disabled={!id() || state.busy}
                onClick={(e: MouseEvent) => {
                  e.stopPropagation()
                  void viewConversation()
                }}
              >
                GPT-6 Pro <span class="text-text-weak">Chat</span>
              </button>
              <span data-slot="basic-tool-tool-subtitle" data-queue-reason={queueReason() || undefined}>
                {phaseLabel()}
              </span>
              <Show when={entry().state?.kind === "archive" || entry().freshness === "stale"}>
                <span class="text-11-regular text-text-weak" data-testid="gpt-pro-state-provenance">
                  {t(entry().freshness === "stale" ? "ui.tool.gptPro.state.stale" : "ui.tool.gptPro.state.archive")}
                </span>
              </Show>
              <Show when={execution()?.background}>
                <span class="text-11-regular text-text-weak" data-testid="gpt-pro-background-badge">
                  {t("ui.tool.gptPro.background")}
                </span>
              </Show>
              <Show when={execution()?.stopPending}>
                <span class="text-11-regular text-text-weak" role="status">
                  {t("ui.tool.gptPro.stopPending")}
                </span>
              </Show>
            </div>
            <span data-slot="basic-tool-tool-action">
              <Show when={capabilities().background}>
                <Button
                  size="small"
                  variant="ghost"
                  icon="arrow-down-to-line"
                  disabled={state.busy}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation()
                    void command("background")
                  }}
                >
                  {t("ui.tool.gptPro.toBackground")}
                </Button>
              </Show>
              <Show when={capabilities().pause}>
                <Button
                  size="small"
                  variant="ghost"
                  icon="pause"
                  disabled={state.busy}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation()
                    void command("pause")
                  }}
                >
                  {t("ui.tool.gptPro.pause")}
                </Button>
              </Show>
              <Button
                size="small"
                variant="ghost"
                icon="eye"
                title={t("ui.tool.gptPro.viewHint")}
                disabled={!id() || state.busy}
                onClick={(e: MouseEvent) => {
                  e.stopPropagation()
                  void viewConversation()
                }}
              >
                {t("ui.tool.gptPro.view")}
              </Button>
              <Show when={capabilities().resume}>
                <Button
                  size="small"
                  variant="ghost"
                  icon="play"
                  title={t("ui.tool.gptPro.resumeHint")}
                  disabled={!id() || state.busy}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation()
                    void command("resume")
                  }}
                >
                  {t("ui.tool.gptPro.resume")}
                </Button>
              </Show>
              <Show when={capabilities().stop}>
                <Button
                  size="small"
                  variant="ghost"
                  icon="stop"
                  disabled={state.busy}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation()
                    void command("stop")
                  }}
                >
                  {t("ui.tool.gptPro.stop")}
                </Button>
              </Show>
              <Show when={historyToggle()}>
                <Button
                  size="small"
                  variant="ghost"
                  data-testid="gpt-pro-history-toggle"
                  onClick={(event: MouseEvent) => {
                    event.stopPropagation()
                    set("historyOpen", !state.historyOpen)
                  }}
                >
                  {t("ui.tool.gptPro.state.history")}
                </Button>
              </Show>
            </span>
          </div>
        }
      />
      <Show when={attachments().length > 0}>
        <div
          class="gpt-pro-tool__attachments"
          role="group"
          aria-label={t("ui.tool.gptPro.attachments")}
          data-testid="gpt-pro-attachments-below"
        >
          <For each={attachments()}>
            {(attachment) => {
              const statusLabel = () => t(`ui.tool.gptPro.attachment.${attachment.status}`)
              const accessibleName = () => `${attachment.name} · ${statusLabel()}`
              return (
                <button
                  type="button"
                  class="gpt-pro-attachment-chip"
                  classList={{ "gpt-pro-attachment-chip--previewable": canPreview(attachment) }}
                  data-testid="gpt-pro-attachment"
                  data-attachment-status={attachment.status}
                  aria-label={t("ui.tool.gptPro.attachment.previewAction", {
                    name: attachment.name,
                    status: statusLabel(),
                  })}
                  title={
                    attachment.error
                      ? `${accessibleName()} · ${t("ui.tool.gptPro.error.attachment.hint")}`
                      : accessibleName()
                  }
                  disabled={!canPreview(attachment) || state.preview.loading}
                  onClick={(event: MouseEvent) => {
                    event.stopPropagation()
                    void previewAttachment(attachment)
                  }}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key === "Enter" || event.key === " ") event.stopPropagation()
                  }}
                >
                  <FileIcon
                    class="gpt-pro-attachment-chip__icon"
                    node={{ path: previewPath(attachment.name, attachment.mime ?? ""), type: "file" }}
                    aria-hidden="true"
                  />
                  <span class="gpt-pro-attachment-chip__name" title={attachment.name}>
                    {attachment.name}
                  </span>
                  <span class="gpt-pro-attachment-chip__status" aria-hidden="true">
                    {statusLabel()}
                  </span>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
      {/* Keep the lazy preview import local so it cannot replace the timeline's Suspense fallback. */}
      <Suspense
        fallback={
          <Show when={state.preview.open}>
            <div class="gpt-pro-preview-loading" role="status" data-testid="gpt-pro-preview-loading-shell">
              <Spinner />
              {t("ui.tool.gptPro.attachment.previewLoading")}
            </div>
          </Show>
        }
      >
        <Show when={state.preview.open}>
          <AttachmentPreviewDialog state={state.preview} onClose={closePreview} />
        </Show>
      </Suspense>
      <Show when={state.error}>
        <section data-testid="gpt-pro-operation-error" class="text-12-regular text-text-weak">
          <div>{t("ui.tool.gptPro.state.operationFailed")}</div>
          <GptProErrorNotice error={state.error} />
        </section>
      </Show>
      <Show
        when={
          (!id() && (props.error || attachments().some((item) => item.error))) ||
          (entry().freshness === "current" && execution())
        }
      >
        <GptProErrorNotice
          error={state.error ? (execution()?.error ?? "") : error()}
          code={execution()?.errorCode ?? undefined}
          phase={phase()}
          queueReason={queueReason()}
          humanAction={execution()?.recovery?.humanAction}
          busy={state.busy}
          onOpenPage={id() && api() ? () => void command("open") : undefined}
        />
      </Show>
      <Show when={state.historyOpen}>
        <section data-testid="gpt-pro-historical-record" class="p-3 text-12-regular text-text-weak">
          <Show when={!historyText() && (historicalPhaseLabel() || state.history.loading)}>
            <div class="flex items-center gap-2">
              <span>{historicalPhaseLabel()}</span>
              <Show when={state.history.loading}>
                <Spinner />
              </Show>
            </div>
          </Show>
          <Show when={!historyOnly() && historicalAttachments().length}>
            <div>
              {historicalAttachments()
                .map((attachment) => attachment.name)
                .join(", ")}
            </div>
          </Show>
          <Show when={historyText()}>
            {(text) => {
              const [markdownReady, setMarkdownReady] = createSignal(false)
              return (
                <div
                  class="mt-2 max-h-96 overflow-y-auto rounded-lg border border-border-weak-base bg-background-base p-3"
                  data-scrollable
                  data-testid="gpt-pro-historical-output"
                >
                  <pre
                    class="whitespace-pre-wrap break-words text-13-regular text-text-base"
                    classList={{ hidden: markdownReady() }}
                    aria-hidden={markdownReady()}
                    data-testid="gpt-pro-historical-text-fallback"
                  >
                    {text()}
                  </pre>
                  <Markdown
                    text={text()}
                    cacheKey={`gpt-pro-history-${props.part?.id ?? id() ?? "record"}`}
                    fileLinks={false}
                    eager
                    onStage={(_key, stage) => {
                      if (stage === "full") setMarkdownReady(true)
                    }}
                    class="gpt-pro-result-markdown"
                  />
                </div>
              )
            }}
          </Show>
          <Show when={state.history.error}>
            <GptProErrorNotice error={state.history.error} />
          </Show>
          <Show when={historicalDiagnostic()}>
            <details data-testid="gpt-pro-historical-error">
              <summary class="cursor-pointer">{t("ui.tool.gptPro.error.details")}</summary>
              <pre class="whitespace-pre-wrap break-words">{historicalDiagnostic()}</pre>
            </details>
          </Show>
        </section>
      </Show>
    </div>
  )
}
