import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { gptProTerminal, type GptProAPI, type GptProJob } from "@opencode-ai/util/gpt-pro"
import { BasicTool } from "./basic-tool"
import { Button } from "./button"
import { handoffGptPro } from "./gpt-pro-handoff"
import { useI18n } from "../context/i18n"

type Props = {
  status?: string
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  output?: string
  part?: ToolPart
}
type AttachmentStatus = "pending" | "uploading" | "ready" | "failed" | "unknown"
type AttachmentView = { id: string; name: string; status: AttachmentStatus; error?: string }
const api = () => (window as unknown as { api?: { gptPro?: GptProAPI } }).api?.gptPro

export function attachmentViews(value: unknown): AttachmentView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return []
    const attachment = item as Record<string, unknown>
    const rawName = typeof attachment.name === "string" ? attachment.name : ""
    // Names are display-only. Never expose the separately stored authorized path.
    const name = rawName.split(/[\\/]/).filter(Boolean).at(-1) || `Attachment ${index + 1}`
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
    return [{
      id: typeof attachment.id === "string" ? attachment.id : `${index}:${name}`,
      name,
      status,
      error: error || undefined,
    }]
  })
}

export function GptProTool(props: Props) {
  const t = useI18n().t
  const id = createMemo(() =>
    typeof props.metadata.consultation_id === "string" ? props.metadata.consultation_id : undefined,
  )
  const [state, set] = createStore({ error: "", busy: false, job: undefined as GptProJob | undefined })
  const localStatus = () => state.job && (state.job.id !== id() || props.status !== "running")
  const phase = () =>
    String((localStatus() ? state.job!.phase : props.metadata.phase) ?? state.job?.phase ?? props.status ?? "")
  const status = () => {
    const current = phase()
    if (current === "completed") return "completed"
    if (["failed", "send_uncertain", "interrupted", "cancelled"].includes(current)) return "error"
    if (["queued", "preparing", "sending", "generating"].includes(current)) return "running"
    if (current === "paused") return "pending"
    return props.status
  }
  const error = () => String(state.error || (localStatus() ? (state.job?.error ?? "") : (props.metadata.error ?? "")))
  const attachments = createMemo(() => {
    const jobAttachments = state.job?.attachments
    if (Array.isArray(jobAttachments)) return attachmentViews(jobAttachments)
    const metadataAttachments = props.metadata.attachments
    if (Array.isArray(metadataAttachments)) return attachmentViews(metadataAttachments)
    return attachmentViews(props.input.attachments)
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
    if (!job || props.status === "running" || (gptProTerminal(job.phase) && job.phase !== "paused")) return
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
      set("error", String(error))
    } finally {
      set("busy", false)
    }
  }
  const viewConversation = async () => {
    const client = api()
    const jobID = state.job?.id ?? id()
    if (!client || !jobID) return
    set({ busy: true, error: "" })
    try {
      set("job", await handoffGptPro(client, jobID))
    } catch (error) {
      set("error", String(error))
    } finally {
      set("busy", false)
    }
  }
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
                disabled={!id()}
                onClick={(e: MouseEvent) => {
                  e.stopPropagation()
                  void viewConversation()
                }}
              >
                GPT-6 Pro <span class="text-text-weak">Chat</span>
              </button>
              <span data-slot="basic-tool-tool-subtitle">{t(`ui.tool.gptPro.phase.${phase()}`)}</span>
              <Show when={state.job?.background ?? props.metadata.background}>
                <span class="text-11-regular text-text-weak" data-testid="gpt-pro-background-badge">
                  {t("ui.tool.gptPro.background")}
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
              <Show when={phase() === "paused"}>
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
      <Show when={error()}>
        <p class="p-2 text-12-regular text-text-critical-base" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={attachments().length > 0}>
        <ul class="flex flex-col gap-1 px-2 pb-2" data-testid="gpt-pro-attachments" aria-label={t("ui.tool.gptPro.attachments")}>
          <For each={attachments()}>
            {(attachment) => (
              <li class="flex min-w-0 flex-col gap-1 text-12-regular" data-testid="gpt-pro-attachment">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="min-w-0 flex-1 truncate" title={attachment.name}>{attachment.name}</span>
                  <span class="shrink-0 text-text-weak" data-attachment-status={attachment.status}>
                    {t(`ui.tool.gptPro.attachment.${attachment.status}`)}
                  </span>
                </div>
                <Show when={attachment.status === "failed" && attachment.error}>
                  <span class="text-text-critical-base" role="status">{attachment.error}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
