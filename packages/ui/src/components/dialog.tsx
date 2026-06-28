import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { ComponentProps, JSXElement, Match, ParentProps, Show, splitProps, Switch } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export interface DialogProps extends ParentProps {
  title?: JSXElement
  description?: JSXElement
  action?: JSXElement
  size?: "normal" | "large" | "x-large"
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  containerStyle?: ComponentProps<"div">["style"]
  fit?: boolean
  transition?: boolean
}

const DIALOG_LOCAL_KEYS = [
  "children",
  "title",
  "description",
  "action",
  "size",
  "class",
  "classList",
  "containerStyle",
  "fit",
  "transition",
] as const

export function Dialog(props: DialogProps) {
  const i18n = useI18n()
  const [local, rest] = splitProps(props, DIALOG_LOCAL_KEYS)
  return (
    <div
      data-component="dialog"
      data-fit={local.fit ? true : undefined}
      data-size={local.size || "normal"}
      data-transition={local.transition ? true : undefined}
      {...rest}
    >
      <div data-slot="dialog-container" style={local.containerStyle}>
        <Kobalte.Content
          data-slot="dialog-content"
          data-no-header={!local.title && !local.action ? "" : undefined}
          classList={{
            ...(local.classList ?? {}),
            [local.class ?? ""]: !!local.class,
          }}
          onOpenAutoFocus={(e) => {
            const node = e.currentTarget as HTMLElement | null
            const autofocusEl = node?.querySelector("[data-autofocus], [autofocus]") as HTMLElement | null
            if (autofocusEl) {
              e.preventDefault()
              autofocusEl.focus()
            }
          }}
        >
          <Show when={local.title || local.action}>
            <div data-slot="dialog-header">
              <Show when={local.title}>
                <Kobalte.Title data-slot="dialog-title">{local.title}</Kobalte.Title>
              </Show>
              <Switch>
                <Match when={local.action}>{local.action}</Match>
                <Match when={true}>
                  <Kobalte.CloseButton
                    data-slot="dialog-close-button"
                    as={IconButton}
                    icon="close"
                    variant="ghost"
                    aria-label={i18n.t("ui.common.close")}
                  />
                </Match>
              </Switch>
            </div>
          </Show>
          <Show when={local.description}>
            <Kobalte.Description data-slot="dialog-description" style={{ "margin-left": "-4px" }}>
              {local.description}
            </Kobalte.Description>
          </Show>
          <div data-slot="dialog-body">{local.children}</div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
