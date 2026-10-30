import { createEffect, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { ExternalSessionState, Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"

export function ExternalSessionComposer(props: { session: Session }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore({
    control: undefined as ExternalSessionState | undefined,
    draft: "",
    requesting: false,
    error: "",
  })
  let revision = 0
  const sendBlocked = () =>
    state.requesting ||
    !state.draft.trim() ||
    !state.control?.active ||
    state.control.busy ||
    state.control.queued ||
    state.control.stopping

  createEffect(
    on(
      () => props.session.id,
      (sessionID) => {
        let disposed = false
        let refreshing = false
        setState({ control: undefined, draft: "", error: "", requesting: false })
        const refresh = async () => {
          if (refreshing || disposed || state.requesting) return
          refreshing = true
          const current = revision
          try {
            const result = await sdk.client.session.externalControl(
              { sessionID, action: "status" },
              { throwOnError: true },
            )
            if (!disposed && current === revision) setState({ control: result.data, error: "" })
          } catch (error) {
            if (!disposed) setState("error", error instanceof Error ? error.message : String(error))
          } finally {
            refreshing = false
          }
        }
        void refresh()
        const timer = setInterval(() => void refresh(), 1000)
        onCleanup(() => {
          disposed = true
          clearInterval(timer)
        })
      },
    ),
  )

  const act = async (action: "start" | "message" | "finish" | "stop") => {
    if (state.requesting || (action === "message" && sendBlocked())) return
    const sessionID = props.session.id
    revision++
    setState({ requesting: true, error: "" })
    console.debug(`[external-session] control child=${sessionID} action=${action}`)
    try {
      const result = await sdk.client.session.externalControl(
        {
          sessionID,
          action,
          ...(action === "message" ? { message: state.draft.trim(), requestID: crypto.randomUUID() } : {}),
        },
        { throwOnError: true },
      )
      if (props.session.id !== sessionID) return
      setState("control", result.data)
      if (action === "message") setState("draft", "")
    } catch (error) {
      if (props.session.id === sessionID) setState("error", error instanceof Error ? error.message : String(error))
      console.warn(`[external-session] failed child=${sessionID} action=${action} error=${String(error)}`)
    } finally {
      if (props.session.id === sessionID) setState("requesting", false)
    }
  }

  return (
    <div
      data-component="external-session-composer"
      class="rounded-lg border border-border-weak-base bg-background-base p-3"
    >
      <div class="flex flex-wrap items-center justify-between gap-2 text-12-regular text-text-weak">
        <span>
          {props.session.external?.advisor} ·{" "}
          {language.t(
            !state.control
              ? "session.external.loading"
              : state.control.stopping
                ? "session.external.stopping"
                : !state.control.available
                  ? "session.external.readOnly"
                  : state.control.waitingForInput
                    ? "session.external.waiting"
                    : "session.external.running",
          )}
        </span>
        <Show when={state.control?.available}>
          <div class="flex gap-2">
            <Show
              when={!state.control?.active}
              fallback={
                <Button size="small" variant="ghost" disabled={state.requesting} onClick={() => void act("finish")}>
                  {language.t("session.external.finish")}
                </Button>
              }
            >
              <Button size="small" disabled={state.requesting || state.control?.busy} onClick={() => void act("start")}>
                {language.t("session.external.start")}
              </Button>
            </Show>
            <Button size="small" variant="ghost" disabled={state.requesting} onClick={() => void act("stop")}>
              {language.t("session.external.stop")}
            </Button>
          </div>
        </Show>
      </div>
      <Show when={state.control?.available && state.control.active}>
        <form
          class="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void act("message")
          }}
        >
          <textarea
            data-testid="external-session-input"
            class="min-h-20 w-full resize-y rounded-md border border-border-weak-base bg-background-stronger p-3 text-14-regular text-text-strong outline-none focus:border-border-interactive-base"
            value={state.draft}
            onInput={(event) => setState("draft", event.currentTarget.value)}
            placeholder={language.t("session.external.placeholder")}
          />
          <Button type="submit" size="small" class="self-end" disabled={sendBlocked()}>
            {language.t("session.external.send")}
          </Button>
        </form>
      </Show>
      <Show when={props.session.external?.historical}>
        <p class="mt-2 text-12-regular text-text-weak">{language.t("session.external.history")}</p>
      </Show>
      <Show when={state.error}>
        <p role="alert" class="mt-2 text-12-regular text-text-danger">
          {state.error}
        </p>
      </Show>
    </div>
  )
}
