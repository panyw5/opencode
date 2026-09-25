import type { PermissionRequest, QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { For, Show, createEffect, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { useLanguage } from "@/context/language"
import { quickQuestionAnswers, quickRequestNotFound } from "./helpers"

type Client = {
  permission: {
    respond: (input: {
      sessionID: string
      permissionID: string
      response: "once" | "always" | "reject"
    }) => Promise<unknown>
  }
  question: {
    reply: (input: { requestID: string; answers: QuestionAnswer[] }) => Promise<unknown>
    reject: (input: { requestID: string }) => Promise<unknown>
  }
}

function QuickQuestion(props: {
  request: QuestionRequest
  client: Client
  onDone: (request: QuestionRequest) => void
}) {
  const [selected, setSelected] = createSignal<Record<number, string[]>>({})
  const [custom, setCustom] = createSignal<Record<number, string>>({})
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal("")
  const language = useLanguage()
  const toggle = (index: number, label: string) => {
    if (sending()) return
    const question = props.request.questions[index]
    const current = selected()[index] ?? []
    if (question?.multiple === true) {
      const next = current.includes(label) ? current.filter((x) => x !== label) : [...current, label]
      console.debug(
        `[quick-assistant] question option request=${props.request.id} index=${index} selected=${next.includes(label) ? 1 : 0}`,
      )
      setSelected((items) => ({
        ...items,
        [index]: next,
      }))
      return
    }
    console.debug(`[quick-assistant] question option request=${props.request.id} index=${index} selected=1`)
    setSelected((items) => ({ ...items, [index]: [label] }))
  }
  const submit = async () => {
    if (sending()) return
    const answers: QuestionAnswer[] = quickQuestionAnswers(props.request.questions, selected(), custom())
    if (answers.some((answer) => answer.length === 0)) {
      setError(language.t("common.requestFailed"))
      return
    }
    console.debug(`[quick-assistant] question submit request=${props.request.id} session=${props.request.sessionID}`)
    setSending(true)
    setError("")
    try {
      await props.client.question.reply({ requestID: props.request.id, answers })
      console.debug(`[quick-assistant] question reply success request=${props.request.id}`)
      props.onDone(props.request)
    } catch (error) {
      console.error(`[quick-assistant] question reply failed request=${props.request.id}`, error)
      if (quickRequestNotFound(error)) props.onDone(props.request)
      else setError(error instanceof Error ? error.message : language.t("common.requestFailed"))
    } finally {
      setSending(false)
    }
  }
  const skip = async () => {
    if (sending()) return
    console.debug(`[quick-assistant] question skip request=${props.request.id}`)
    setSending(true)
    setError("")
    try {
      await props.client.question.reject({ requestID: props.request.id })
      props.onDone(props.request)
    } catch (error) {
      console.error(`[quick-assistant] question reject failed request=${props.request.id}`, error)
      if (quickRequestNotFound(error)) props.onDone(props.request)
      else setError(error instanceof Error ? error.message : language.t("common.requestFailed"))
    } finally {
      setSending(false)
    }
  }
  return (
    <DockPrompt
      kind="question"
      header={<div data-slot="question-header-title">{language.t("notification.question.title")}</div>}
      footer={
        <div data-slot="question-footer-actions">
          <Button variant="ghost" size="large" disabled={sending()} onClick={() => void skip()}>
            {language.t("ui.common.dismiss")}
          </Button>
          <Button variant="primary" size="large" disabled={sending()} onClick={() => void submit()}>
            {language.t("ui.common.submit")}
          </Button>
        </div>
      }
    >
      <Show when={error()}>
        <div class="text-12-regular text-text-danger-base">{error()}</div>
      </Show>
      <For each={props.request.questions}>
        {(item, index) => (
          <div class="flex flex-col gap-2 py-2">
            <div data-slot="question-text">{item.question}</div>
            <For each={item.options ?? []}>
              {(option) => {
                const picked = () => (selected()[index()] ?? []).includes(option.label)
                return (
                  <button
                    type="button"
                    data-slot="quick-question-option"
                    class="flex w-full items-center gap-3 rounded-[14px] border px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-base"
                    style={{ "border-radius": "14px" }}
                    aria-pressed={picked()}
                    disabled={sending()}
                    onClick={() => toggle(index(), option.label)}
                  >
                    <span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span class="min-w-0 max-w-full break-words font-semibold" style={{ "font-weight": "600" }}>
                        {option.label}
                      </span>
                      <Show when={option.description}>
                        <span class="min-w-0 max-w-full break-words text-12-regular text-text-weaker">
                          {option.description}
                        </span>
                      </Show>
                    </span>
                    <span
                      data-slot="quick-question-option-indicator"
                      class="flex size-5 shrink-0 items-center justify-center border"
                      classList={{ "rounded-md": item.multiple, "rounded-full": !item.multiple }}
                      aria-hidden="true"
                    >
                      <Show when={picked()}>
                        <Icon name="check-small" size="small" />
                      </Show>
                    </span>
                  </button>
                )
              }}
            </For>
            <Show when={(item as typeof item & { custom?: boolean }).custom !== false}>
              <textarea
                class="min-h-14 resize-none rounded-[14px] border border-border-weak-base bg-transparent p-2"
                style={{ "border-radius": "14px" }}
                placeholder={language.t("ui.question.custom.placeholder")}
                value={custom()[index()] ?? ""}
                disabled={sending()}
                onInput={(event) => setCustom((items) => ({ ...items, [index()]: event.currentTarget.value }))}
              />
            </Show>
          </div>
        )}
      </For>
    </DockPrompt>
  )
}

export function QuickAssistantRequests(props: {
  client: Client
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  onPermissionDone: (request: PermissionRequest) => void
  onQuestionDone: (request: QuestionRequest) => void
}) {
  const language = useLanguage()
  const [permissionSending, setPermissionSending] = createSignal(false)
  const [permissionError, setPermissionError] = createSignal("")
  const permission = () => props.permissions[0]
  const question = () => props.questions[0]
  createEffect(() => {
    const permissionID = permission()?.id
    const questionID = question()?.id
    console.debug(
      `[quick-assistant] request panel permission=${permissionID ?? "none"} question=${questionID ?? "none"}`,
    )
    setPermissionError("")
  })
  return (
    <Show when={permission() || question()}>
      <div
        data-component="quick-assistant-requests"
        class="min-h-0 max-h-full shrink-0 overflow-y-auto overscroll-contain"
      >
        <Show when={permission()}>
          <div role="status" class="px-4 py-2 text-12-regular text-text-weaker">
            {language.t("quickAssistant.waiting.permission")}
          </div>
        </Show>
        <Show when={permission()}>
          {(request) => (
            <>
              <SessionPermissionDock
                request={request()}
                responding={permissionSending()}
                onDecide={async (response) => {
                  if (permissionSending()) return
                  const snapshot = { ...request() }
                  setPermissionSending(true)
                  setPermissionError("")
                  console.debug(`[quick-assistant] permission response request=${snapshot.id} response=${response}`)
                  try {
                    await props.client.permission.respond({
                      sessionID: snapshot.sessionID,
                      permissionID: snapshot.id,
                      response,
                    })
                    props.onPermissionDone(snapshot)
                  } catch (error) {
                    console.error(`[quick-assistant] permission response failed request=${snapshot.id}`, error)
                    if (quickRequestNotFound(error)) props.onPermissionDone(snapshot)
                    else setPermissionError(error instanceof Error ? error.message : language.t("common.requestFailed"))
                  } finally {
                    setPermissionSending(false)
                  }
                }}
              />
              <Show when={permissionError()}>
                <div class="px-4 py-2 text-12-regular text-text-danger-base">{permissionError()}</div>
              </Show>
            </>
          )}
        </Show>
        <Show when={!permission()}>
          <Show keyed when={question()}>
            {(request) => <QuickQuestion request={request} client={props.client} onDone={props.onQuestionDone} />}
          </Show>
        </Show>
      </div>
    </Show>
  )
}
