import { createEffect, createMemo, For, lazy, onCleanup, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { gptProTerminal, type GptProAPI, type GptProJob } from "@opencode-ai/util/gpt-pro"
import { BasicTool } from "./basic-tool"
import { Button } from "./button"
import { FileIcon } from "./file-icon"
import { Spinner } from "./spinner"
import { handoffGptPro } from "./gpt-pro-handoff"
import { resolveGptProView, type GptProCachedResult } from "./gpt-pro-result"
import { useI18n } from "../context/i18n"
import { GptProErrorNotice } from "./gpt-pro-error-notice"
import { gptProCanResume, type GptProIssueCode } from "@opencode-ai/util/gpt-pro-error"

const AttachmentPreviewDialog = lazy(() =>
  import("./gpt-pro-attachment-preview").then((module) => ({ default: module.AttachmentPreviewDialog })),
)
const GptProResultPreviewDialog = lazy(() =>
  import("./gpt-pro-result-preview").then((module) => ({ default: module.GptProResultPreviewDialog })),
)

type Props = {
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
const api = () =>
  typeof window === "undefined" ? undefined : (window as unknown as { api?: { gptPro?: GptProAPI } }).api?.gptPro

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
  const t = useI18n().t
  const id = createMemo(() =>
    typeof props.metadata.consultation_id === "string" ? props.metadata.consultation_id : undefined,
  )
  const [state, set] = createStore({
    error: "",
    busy: false,
    job: undefined as GptProJob | undefined,
    preview: { open: false, loading: false, error: "", file: undefined as AttachmentPreviewData | undefined },
    result: {
      open: false,
      loading: false,
      opening: false,
      error: "",
      errorCode: undefined as GptProIssueCode | undefined,
      originalURL: undefined as string | undefined,
      jobID: undefined as string | undefined,
      result: undefined as GptProCachedResult | undefined,
    },
  })
  const previewJobID = () => gptProPreviewJobID(state.job?.id, id())
  let previewRequest = 0
  let resultRequest = 0
  const closePreview = () => {
    console.debug(`[gpt-pro-tool] attachment preview closed job=${previewJobID() ?? "unknown"}`)
    previewRequest++
    set("preview", { open: false, loading: false, error: "", file: undefined })
  }
  createEffect(() => {
    console.debug(`[gpt-pro-tool] tool mounted job=${id() ?? "unknown"}`)
  })
  onCleanup(() => {
    console.debug(
      `[gpt-pro-tool] tool cleanup job=${id() ?? "unknown"} previewOpen=${state.preview.open} previewLoading=${state.preview.loading}`,
    )
    previewRequest++
    resultRequest++
  })
  const localStatus = () => state.job && (state.job.id !== id() || props.status !== "running")
  const phase = () =>
    String((localStatus() ? state.job!.phase : props.metadata.phase) ?? state.job?.phase ?? props.status ?? "")
  const queueReason = () =>
    String((localStatus() ? state.job?.queueReason : props.metadata.queue_reason) ?? "")
  const queueOwnerConsultationID = () =>
    String((localStatus() ? state.job?.queueOwnerConsultationID : props.metadata.queue_owner_consultation_id) ?? "")
  const phaseLabel = () => {
    if (phase() === "queued" && queueReason() === "login_import") return t("ui.tool.gptPro.error.login_import_pending.title")
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
        (localStatus() ? (state.job?.error ?? "") : (props.error ?? props.metadata.error ?? "")) ||
        attachments()
          .filter((item) => item.error)
          .map((item) => `Attachment ${item.name}: ${item.error}`)
          .join("\n"),
    )
  const canResume = () =>
    gptProCanResume({
      error: error(),
      phase: phase(),
      code: state.error ? undefined : localStatus() ? state.job?.errorCode : props.metadata.error_code,
      sendAttempted: state.job?.sendAttempted ?? props.metadata.send_attempted === true,
      submitted: state.job?.submitted ?? props.metadata.submitted === true,
      userID: state.job?.userID ?? (typeof props.metadata.user_id === "string" ? props.metadata.user_id : undefined),
    })
  const attachments = createMemo(() => {
    const jobAttachments = state.job?.attachments
    if (Array.isArray(jobAttachments)) return attachmentViews(jobAttachments)
    const metadataAttachments = props.metadata.attachments
    if (Array.isArray(metadataAttachments) && metadataAttachments.length) return attachmentViews(metadataAttachments)
    const inputAttachments = attachmentViews(props.input.attachments)
    if (inputAttachments.length) return inputAttachments
    return fallbackAttachmentViews(props.input.files, status() === "error")
  })
  createEffect(() => {
    const jobID = id()
    const client = api()
    if (!jobID || !client || props.status === "running") return
    let disposed = false
    console.debug(`[gpt-pro-tool] refreshing saved card id=${jobID}`)
    // Archived tool metadata is a snapshot; another card may have resumed this job.
    void client
      .command({ action: "status", id: jobID })
      .then((job) => {
        if (!disposed && !state.busy) {
          console.debug(`[gpt-pro-tool] saved card refreshed id=${job.id} phase=${job.phase}`)
          set("job", job)
        }
      })
      .catch(() => {
        if (!disposed)
          console.debug(`[gpt-pro-tool] saved consultation unavailable id=${jobID}; historical metadata retained`)
        // Old jobs may have left the bounded history; keep their stored metadata.
      })
    onCleanup(() => {
      disposed = true
    })
  })
  createEffect(() => {
    const job = state.job
    if (!job || props.status === "running" || (gptProTerminal(job.phase) && job.phase !== "paused" && !job.stopPending))
      return
    const jobID = job.id
    let disposed = false
    let polling = false
    const timer = setInterval(() => {
      const client = api()
      if (state.busy || polling || !client) return
      polling = true
      void client
        .command({ action: "status", id: jobID })
        .then((next) => {
          if (!disposed && !state.busy && state.job?.id === jobID && next.updatedAt >= state.job.updatedAt) {
            set("job", next)
            if (state.error === t("ui.tool.gptPro.statusError")) set("error", "")
          }
        })
        .catch(() => {
          if (!disposed) set("error", t("ui.tool.gptPro.statusError"))
        })
        .finally(() => {
          polling = false
        })
    }, 1000)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
    })
  })
  const command = async (
    action: "open" | "stop" | "pause" | "resume" | "intervene" | "status" | "background",
    prompt?: string,
  ) => {
    if (!id() || !api()) return
    set({ busy: true, error: "" })
    try {
      const job = await api()!.command({ action, id: state.job?.id ?? id(), prompt })
      set("job", job)
      return job
    } catch (error) {
      console.warn(`[gpt-pro-tool] command failed action=${action} id=${state.job?.id ?? id()} phase=${phase()}`)
      set("error", String(error))
    } finally {
      set("busy", false)
    }
  }
  const viewConversation = async () => {
    const client = api()
    const jobID = state.job?.id ?? id()
    if (!client || !jobID) return
    const request = ++resultRequest
    set({ busy: true, error: "" })
    set("result", {
      open: false,
      loading: false,
      opening: false,
      error: "",
      originalURL: typeof props.metadata.url === "string" ? props.metadata.url : state.job?.url,
      jobID,
      result: undefined,
    })
    console.debug(`[gpt-pro-tool] resolving View action id=${jobID}`)
    try {
      const resolution = await resolveGptProView(client, jobID, props.output)
      if (request !== resultRequest) return
      if (resolution.kind === "cached") {
        console.debug(
          `[gpt-pro-tool] cached result ready id=${resolution.result.id} source=${resolution.result.source}`,
        )
        set("busy", false)
        set("result", {
          open: true,
          loading: false,
          opening: false,
          error: "",
          originalURL: resolution.result.url || undefined,
          jobID: resolution.result.id,
          result: resolution.result,
        })
        return
      }
      if (resolution.kind === "unavailable") {
        console.debug(`[gpt-pro-tool] cached result unavailable id=${resolution.id}`)
        set("busy", false)
        set("result", {
          open: true,
          loading: false,
          opening: false,
          error: resolution.error || t("ui.tool.gptPro.resultUnavailable"),
          errorCode: resolution.errorCode,
          originalURL:
            resolution.url ||
            (typeof props.metadata.url === "string" ? props.metadata.url : state.job?.url) ||
            undefined,
          jobID: resolution.id,
          result: undefined,
        })
        return
      }
      set("result", {
        open: false,
        loading: false,
        opening: false,
        error: "",
        originalURL: undefined,
        jobID: undefined,
        result: undefined,
      })
      set("job", resolution.job)
      set("job", await handoffGptPro(client, resolution.job.id))
      set("busy", false)
    } catch (error) {
      if (request !== resultRequest) return
      set("busy", false)
      set("error", String(error))
      set("result", {
        open: false,
        loading: false,
        opening: false,
        error: "",
        originalURL: undefined,
        jobID: undefined,
        result: undefined,
      })
    }
  }
  const closeResult = () => {
    resultRequest++
    set("result", {
      open: false,
      loading: false,
      opening: false,
      error: "",
      originalURL: undefined,
      jobID: undefined,
      result: undefined,
    })
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
    <div data-component="gpt-pro-tool">
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
              <Show when={state.job?.background ?? props.metadata.background}>
                <span class="text-11-regular text-text-weak" data-testid="gpt-pro-background-badge">
                  {t("ui.tool.gptPro.background")}
                </span>
              </Show>
              <Show when={state.job?.stopPending ?? props.metadata.stop_pending}>
                <span class="text-11-regular text-text-weak" role="status">
                  {t("ui.tool.gptPro.stopPending")}
                </span>
              </Show>
            </div>
            <span data-slot="basic-tool-tool-action">
              <Show
                when={
                  ["queued", "preparing", "sending", "generating"].includes(phase()) &&
                  !(state.job?.background ?? props.metadata.background)
                }
              >
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
              <Show when={["preparing", "sending", "generating"].includes(phase())}>
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
              <Show when={canResume()}>
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
              <Show when={["queued", "preparing", "sending", "generating", "paused"].includes(phase())}>
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
      <Suspense fallback={null}>
        <Show when={state.result.open}>
          <GptProResultPreviewDialog
            state={state.result}
            client={api()!}
            jobID={state.result.jobID}
            onClose={closeResult}
          />
        </Show>
      </Suspense>
      <GptProErrorNotice
        error={error()}
        code={state.error ? undefined : localStatus() ? state.job?.errorCode : props.metadata.error_code}
        phase={phase()}
        queueReason={queueReason()}
        needsHuman={(state.job?.recovery ?? (props.metadata.recovery as GptProJob["recovery"]))?.needsHuman}
        busy={state.busy}
        onOpenPage={id() && api() ? () => void command("open") : undefined}
      />
    </div>
  )
}
