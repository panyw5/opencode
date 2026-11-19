import { createMemo, For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  const browserAction = () => {
    if (!props.request.permission.startsWith("browser_")) return ""
    const action = props.request.metadata?.action
    if (typeof action !== "string") return ""
    const key = `session.permission.browser.action.${action}`
    const value = language.t(key as Parameters<typeof language.t>[0])
    return value === key ? "" : value
  }

  const details = createMemo(() => [toolDescription(), browserAction()].filter(Boolean).join(" · "))

  return (
    <DockPrompt
      kind="permission"
      expandLabel={language.t("session.question.expand")}
      collapseLabel={language.t("session.question.collapse")}
      header={
        <div data-slot="permission-row">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <span data-slot="permission-header-title">{language.t("notification.permission.title")}</span>
          <Show when={details()}>
            <span data-slot="permission-hint">{details()}</span>
          </Show>
        </div>
      }
      footer={
        <>
          <div data-slot="permission-footer-actions">
            <Button
              variant="ghost"
              size="large"
              icon="close-small"
              onClick={() => props.onDecide("reject")}
              disabled={props.responding}
            >
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="secondary"
              size="large"
              icon="check-double"
              onClick={() => props.onDecide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button
              variant="primary"
              size="large"
              icon="check"
              onClick={() => props.onDecide("once")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-patterns">
          <For each={props.request.patterns}>{(pattern) => <code data-slot="permission-pattern">{pattern}</code>}</For>
        </div>
      </Show>
    </DockPrompt>
  )
}
