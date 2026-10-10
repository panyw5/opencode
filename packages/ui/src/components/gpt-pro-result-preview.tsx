import { createEffect, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "./button"
import { Dialog } from "./dialog"
import { Markdown } from "./markdown"
import { Spinner } from "./spinner"
import { useDialog } from "../context/dialog"
import { useI18n } from "../context/i18n"
import { handoffGptPro } from "./gpt-pro-handoff"
import type { GptProCachedResult } from "./gpt-pro-result"
import type { GptProAPI } from "@opencode-ai/util/gpt-pro"
import { GptProErrorNotice } from "./gpt-pro-error-notice"
import type { GptProIssueCode } from "@opencode-ai/util/gpt-pro-error"

export type GptProResultPreviewState = {
  open: boolean
  loading: boolean
  opening: boolean
  error: string
  errorCode?: GptProIssueCode
  originalURL?: string
  result?: GptProCachedResult
}

export function closeDialogIfCurrent(
  dialog: { active?: { id: string }; close: () => void },
  expectedID: string | undefined,
) {
  if (!expectedID || dialog.active?.id !== expectedID) return false
  dialog.close()
  return true
}

export function GptProResultPreviewContent(props: { state: GptProResultPreviewState; localError?: string }) {
  const t = useI18n().t
  return (
    <div class="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-4" data-testid="gpt-pro-result-preview">
      <Show when={props.state.loading}>
        <div class="flex min-h-40 items-center justify-center gap-2 text-13-regular text-text-weak" role="status">
          <Spinner />
          {t("ui.tool.gptPro.resultLoading")}
        </div>
      </Show>
      <Show when={props.state.error}>
        <GptProErrorNotice error={props.state.error} code={props.state.errorCode ?? "history_missing"} />
      </Show>
      <Show when={props.localError}>
        <GptProErrorNotice error={props.localError} />
      </Show>
      <Show when={props.state.result}>
        {(result) => (
          <>
            <div class="shrink-0 text-12-regular text-text-weak" data-testid="gpt-pro-result-phase">
              {t(`ui.tool.gptPro.phase.${result().phase}`)}
              <span class="ml-2 select-text">{result().id}</span>
            </div>
            <Show when={result().error}>
              <GptProErrorNotice error={result().error} code={result().errorCode} phase={result().phase} />
            </Show>
            <div class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-weak-base bg-background-base p-4">
              <Show when={result().text} fallback={<p class="text-13-regular text-text-weak">{t("ui.tool.gptPro.resultNoText")}</p>}>
                {(text) => {
                  const [markdownReady, setMarkdownReady] = createSignal(false)
                  return (
                    <>
                      <pre
                        class="whitespace-pre-wrap break-words text-13-regular text-text-base"
                        classList={{ hidden: markdownReady() }}
                        aria-hidden={markdownReady()}
                        data-testid="gpt-pro-result-text-fallback"
                      >
                        {text()}
                      </pre>
                      <Markdown
                        text={text()}
                        cacheKey={`gpt-pro-result-${result().id}`}
                        fileLinks={false}
                        eager
                        onStage={(_key, stage) => {
                          if (stage === "full") setMarkdownReady(true)
                        }}
                        class="gpt-pro-result-markdown"
                      />
                    </>
                  )
                }}
              </Show>
            </div>
          </>
        )}
      </Show>
      <Show when={props.state.opening}>
        <span class="sr-only" role="status">{t("ui.tool.gptPro.resultOpening")}</span>
      </Show>
    </div>
  )
}

export function GptProResultPreviewDialog(props: {
  state: GptProResultPreviewState
  client: Pick<GptProAPI, "command">
  jobID?: string
  onClose: () => void
}) {
  const dialog = useDialog()
  const t = useI18n().t
  const [local, setLocal] = createStore({ opening: false, error: "" })
  const openOriginal = async () => {
    const jobID = props.state.result?.id ?? props.jobID
    if (!jobID) return
    const dialogID = dialog.active?.id
    setLocal({ opening: true, error: "" })
    console.debug(`[gpt-pro-result] opening original page id=${jobID}`)
    try {
      await handoffGptPro(props.client, jobID)
      closeDialogIfCurrent(dialog, dialogID)
    } catch (error) {
      console.warn(`[gpt-pro-result] original page open failed id=${jobID} error=${String(error)}`)
      setLocal("error", String(error))
    } finally {
      setLocal("opening", false)
    }
  }
  let opened = false
  createEffect(() => {
    if (!props.state.open || opened) return
    opened = true
    dialog.show(
      () => (
        <Dialog
          title={t("ui.tool.gptPro.resultTitle")}
          titleAction={
            <Button
              size="small"
              variant="secondary"
              disabled={local.opening || (!props.state.result?.url && !props.state.originalURL) || !props.jobID}
              onClick={() => void openOriginal()}
            >
              {local.opening ? t("ui.tool.gptPro.resultOpening") : t("ui.tool.gptPro.openOriginal")}
            </Button>
          }
          size="x-large"
          class="h-full"
          containerStyle={{ width: "min(calc(100vw - 32px), 960px)", height: "min(calc(100vh - 32px), 760px)" }}
        >
          <GptProResultPreviewContent state={props.state} localError={local.error} />
        </Dialog>
      ),
      props.onClose,
    )
  })
  return null
}
