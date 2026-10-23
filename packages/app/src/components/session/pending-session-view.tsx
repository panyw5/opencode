import { Show, onMount } from "solid-js"
import { Message } from "@opencode-ai/ui/message-part"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useLanguage } from "@/context/language"
import type { PendingSessionSubmission } from "@/components/prompt-input/pending-session"

export function PendingSessionView(props: { submission: PendingSessionSubmission; centered: boolean }) {
  const language = useLanguage()
  onMount(() => {
    console.debug(`[new-session-submit] preview-mounted message=${props.submission.message.id}`)
  })
  return (
    <div
      data-component="pending-session"
      data-message-id={props.submission.message.id}
      data-phase={props.submission.phase}
      class="absolute inset-0 z-10 overflow-y-auto bg-background-stronger"
    >
      <div
        classList={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-[var(--session-content-width)] md:mx-auto": props.centered,
        }}
      >
        <div data-component="session-turn" class="min-w-0 w-full relative" style={{ height: "auto" }}>
          <div class="w-full px-4 md:px-5">
            <Message message={props.submission.message} parts={props.submission.parts} actions={{}} markdownEager />
          </div>
        </div>
        <div class="flex items-center gap-2 px-4 md:px-5 pt-3 text-text-weak text-13-regular" role="status">
          <Show
            when={props.submission.phase !== "failed"}
            fallback={
              <>
                <span class="min-w-0 break-words">{props.submission.error}</span>
                <Button variant="ghost" size="small" onClick={() => props.submission.retry()}>
                  {language.t("prompt.session.retry")}
                </Button>
                <Button variant="ghost" size="small" onClick={() => props.submission.edit()}>
                  {language.t("common.edit")}
                </Button>
              </>
            }
          >
            <Spinner class="size-4" />
            <span>
              {language.t(
                props.submission.phase === "sending" ? "ui.sessionTurn.status.sending" : "prompt.session.preparing",
              )}
            </span>
          </Show>
        </div>
      </div>
    </div>
  )
}
