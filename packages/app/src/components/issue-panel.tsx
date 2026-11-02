import { For, Show, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import type { EventIssueUpdated } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { handleNotificationClick } from "@/utils/notification-click"

type Issue = EventIssueUpdated["properties"]["issue"]
const attention = (issue: Issue) => issue.state === "needs_user" || (issue.state === "failed" && issue.scope !== "tool")

export function IssuePanel(props: { directory?: string; sessionID?: string; all?: boolean }) {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const client = () => sdk.forDomain("opencode").client
  const [state, setState] = createStore({
    items: [] as Issue[],
    history: {} as Record<string, unknown>,
    error: "",
    loading: false,
    more: false,
  })
  let generation = 0
  const matches = (issue: Issue) =>
    (props.all || issue.directory === props.directory) && (!props.sessionID || issue.sessionID === props.sessionID)
  const critical = () => state.items.filter((item) => attention(item) && !item.acknowledgedAt)
  createEffect(() => {
    const directory = props.all ? undefined : props.directory
    const sessionID = props.sessionID
    const current = ++generation
    setState({ loading: true, error: "", items: [], history: {} })
    void Promise.all([
      client().issue.list({ directory, sessionID, limit: "50" }),
      client().issue.list({ directory, sessionID, limit: "100", attention: "true" }),
    ])
      .then(([result, outstanding]) => {
        if (current !== generation) return
        setState("items", (items) => [
          ...items,
          ...(outstanding.data ?? []).filter((item) => !items.some((old) => old.id === item.id)),
          ...(result.data ?? []).filter(
            (item) =>
              !items.some((old) => old.id === item.id) && !(outstanding.data ?? []).some((old) => old.id === item.id),
          ),
        ])
        setState({ more: result.data?.length === 50, loading: false })
        console.debug(
          `[issue-panel] loaded directory=${directory ?? "all"} session=${sessionID ?? "all"} count=${result.data?.length ?? 0}`,
        )
      })
      .catch((error) => {
        if (current !== generation) return
        setState({ error: String(error), loading: false })
        console.error(`[issue-panel] load failed error=${String(error)}`)
      })
    const off = sdk.listenAll((event) => {
      if (event.details.type !== "issue.updated" || !matches(event.details.properties.issue)) return
      const item = event.details.properties.issue
      setState("items", (items) => [item, ...items.filter((old) => old.id !== item.id)])
    })
    onCleanup(() => {
      generation++
      off()
    })
  })

  const history = async (item: Issue) => {
    try {
      const result = await client().issue.get({ issueID: item.id })
      setState("history", item.id, result.data)
      await client().issue.mark({ issueID: item.id, action: "read" })
    } catch (error) {
      setState("error", String(error))
    }
  }
  const acknowledge = async (item: Issue) => {
    try {
      await client().issue.mark({ issueID: item.id, action: "acknowledge" })
      console.debug(`[issue-panel] acknowledged id=${item.id} state=${item.state}`)
    } catch (error) {
      setState("error", String(error))
    }
  }
  const exportReport = async (item: Issue) => {
    try {
      const result = await client().issue.get({ issueID: item.id })
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" }))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `opencode-${item.id}.json`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      console.debug(`[issue-panel] exported id=${item.id}`)
    } catch (error) { setState("error", String(error)) }
  }
  const more = async () => {
    const before = state.items.at(-1)?.id
    try {
      const result = await client().issue.list({
        directory: props.all ? undefined : props.directory,
        sessionID: props.sessionID,
        before,
        limit: "50",
      })
      setState("items", (items) => [
        ...items,
        ...(result.data ?? []).filter((item) => !items.some((old) => old.id === item.id)),
      ])
      setState("more", result.data?.length === 50)
    } catch (error) {
      setState("error", String(error))
    }
  }

  return (
    <Show when={props.all || state.items.length || state.error}>
      <details
        data-component="issue-panel"
        class="pointer-events-auto w-full rounded-lg border border-border-weak-base bg-background-base text-text-base"
        open={critical().length > 0 || props.all}
      >
        <summary class="cursor-pointer px-3 py-2 text-12-medium">
          {language.t("diagnostics.title")} · {state.items.length}{" "}
          <Show when={critical().length}>
            <span class="text-text-critical-base">
              {" "}
              · {language.t("diagnostics.attention", { count: critical().length })}
            </span>
          </Show>
        </summary>
        <div class="max-h-64 overflow-y-auto px-3 pb-3 flex flex-col gap-2">
          <Show when={state.error}>
            <p role="alert" class="text-text-critical-base">
              {state.error}
            </p>
          </Show>
          <Show when={!state.loading && !state.items.length}>
            <p>{language.t("diagnostics.empty")}</p>
          </Show>
          <For each={state.items}>
            {(item) => (
              <details
                data-issue-id={item.id}
                data-issue-state={item.state}
                class="rounded-md border border-border-weak-base px-2 py-2"
                open={attention(item) && !item.acknowledgedAt}
              >
                <summary class="cursor-pointer break-words text-12-regular">
                  <strong>{language.t(`diagnostics.state.${item.state}`)}</strong> · {item.source} · {item.message}
                </summary>
                <div class="mt-2 flex flex-col gap-2 text-11-regular">
                  <span>
                    {item.id} · {item.code} · {new Date(item.updatedAt).toLocaleString()} · {item.storage}
                  </span>
                  <Show when={item.details}>
                    <pre class="whitespace-pre-wrap break-words">{item.details}</pre>
                  </Show>
                  <Show when={item.action}>
                    <p>{item.action}</p>
                  </Show>
                  <Show when={item.acknowledgedAt}>
                    <p>{language.t("diagnostics.acknowledged")}</p>
                  </Show>
                  <div class="flex flex-wrap gap-3">
                    <button type="button" class="underline" onClick={() => void history(item)}>
                      {language.t("diagnostics.history")}
                    </button>
                    <button type="button" class="underline" onClick={() => void exportReport(item)}>{language.t("diagnostics.export")}</button>
                    <Show when={attention(item) && !item.acknowledgedAt}>
                      <button type="button" class="underline" onClick={() => void acknowledge(item)}>
                        {language.t("diagnostics.acknowledge")}
                      </button>
                    </Show>
                    <Show when={props.all && item.sessionID}>
                      <button
                        type="button"
                        class="underline"
                        onClick={() =>
                          handleNotificationClick(`/${base64Encode(item.directory)}/session/${item.sessionID}`)
                        }
                      >
                        {language.t("diagnostics.openSession")}
                      </button>
                    </Show>
                  </div>
                  <Show when={state.history[item.id]}>
                    <pre class="whitespace-pre-wrap break-words text-11-regular">
                      {JSON.stringify(state.history[item.id], null, 2)}
                    </pre>
                  </Show>
                </div>
              </details>
            )}
          </For>
          <Show when={state.more}>
            <button type="button" class="underline" onClick={() => void more()}>
              {language.t("diagnostics.older")}
            </button>
          </Show>
        </div>
      </details>
    </Show>
  )
}

export function DialogIssues() {
  const language = useLanguage()
  return (
    <Dialog title={language.t("diagnostics.title")} class="max-w-3xl">
      <div class="p-4">
        <IssuePanel all />
      </div>
    </Dialog>
  )
}
