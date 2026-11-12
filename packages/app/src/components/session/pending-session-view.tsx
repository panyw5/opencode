import { Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useLanguage } from "@/context/language"
import type { PendingSessionSubmission } from "@/components/prompt-input/pending-session"

// Slim, non-covering status for the first submission. The optimistic message
// itself renders in the normal session timeline — this only surfaces the
// phases the timeline cannot express: "preparing" (waiting on worktree
// creation or markdown prewarm before the session route exists), "sending"
// while still on the draft route (the router commit hands off to the
// timeline's thinking row), and "failed" (retry/edit). On the session route
// itself "sending" renders nothing — the timeline owns that state.
export function PendingSessionBanner(props: { submission: PendingSessionSubmission; ready?: boolean }) {
  const language = useLanguage()
  const params = useParams()
  // During "sending" the banner lives until the timeline's first settled
  // layout — the route commit alone does not mean content can paint.
  return (
    <Show when={props.submission.phase !== "sending" || !params.id || !props.ready}>
      <div
        data-component="pending-session"
        data-phase={props.submission.phase}
        class="absolute top-3 inset-x-0 z-10 flex justify-center pointer-events-none"
      >
        <div
          class="pointer-events-auto flex items-center gap-2 rounded-md bg-background-stronger px-3 py-1.5 text-13-regular text-text-weak shadow-border"
          role="status"
        >
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
              {props.submission.phase === "sending"
                ? language.t("ui.sessionTurn.status.sending")
                : language.t("prompt.session.preparing")}
            </span>
          </Show>
        </div>
      </div>
    </Show>
  )
}
