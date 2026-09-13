import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { createMemo, createUniqueId, Show } from "solid-js"
import { ModelSelectorPopover, parseModelRef, useBoundModelState } from "@/components/dialog-select-model"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"

type Props = {
  setRef: (node: HTMLTextAreaElement) => void
  text: string
  busy: boolean
  loading: boolean
  ready: boolean
  variants: string[]
  variant: string | undefined
  onText: (text: string) => void
  onClose: () => void
  onReset: () => void
  onVariant: (variant: string | undefined) => void
  onSend: () => void
}

const control = { height: "28px" }

function AutoModelRow(props: { active: boolean; label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-action="quick-assistant-model-auto"
      onClick={props.onSelect}
      class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-13-regular text-text-strong transition-colors hover:bg-[var(--list-item-hover-bg)]"
    >
      <span class="truncate">{props.label}</span>
      <Show when={props.active}>
        <Icon name="check-small" size="small" class="shrink-0 text-icon-strong-base" />
      </Show>
    </button>
  )
}

export function QuickAssistantInput(props: Props) {
  const language = useLanguage()
  const settings = useSettings()
  const theme = useTheme()
  const claudeTheme = createMemo(() => theme.themeId() === "claude")
  const formID = createUniqueId()

  const model = useBoundModelState({
    value: () => {
      const value = settings.assistant.model()
      return typeof value === "object" ? `${value.providerID}/${value.modelID}` : ""
    },
    onChange: (next) => {
      const parsed = parseModelRef(next)
      if (!parsed) return
      settings.assistant.setModel(parsed)
    },
  })

  const modelLabel = createMemo(() => {
    const value = settings.assistant.model()
    if (value === "auto") return language.t("settings.assistant.model.option.auto")
    if (value === "disabled") return language.t("settings.assistant.model.option.disabled")
    return model.current()?.name ?? `${value.providerID}/${value.modelID}`
  })

  const variantLabel = createMemo(() => {
    const defaultText = language.t("common.default")
    return (x: string) => (x === "default" ? defaultText : x)
  })

  const variantOptions = createMemo(() => ["default", ...props.variants])

  return (
    <div class="px-3 pb-3 pt-2">
      <form
        id={formID}
        class="rounded-[var(--radius-4xl)] border border-[color-mix(in_srgb,var(--border-weak-base)_60%,transparent)] bg-background-base"
        onSubmit={(event) => {
          event.preventDefault()
          if (props.busy) {
            props.onReset()
            return
          }
          props.onSend()
        }}
      >
        <textarea
          ref={props.setRef}
          rows={3}
          value={props.text}
          placeholder="Ask about the current OpenCode session or a quick task..."
          class="w-full min-h-[84px] resize-none bg-transparent px-4 pt-3.5 pb-1 text-14-regular text-text-strong outline-none placeholder:text-text-weaker"
          style={{ "line-height": "26px" }}
          onInput={(event) => props.onText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              props.onClose()
              return
            }
            if (event.key !== "Enter" || event.shiftKey) return
            event.preventDefault()
            if (props.busy) {
              props.onReset()
              return
            }
            props.onSend()
          }}
        />
        <div class="flex items-center gap-1.5 px-2 pb-2 pt-1">
          <div class="min-w-0 flex-1" />
          <ModelSelectorPopover
            model={model}
            showSummary
            header={({ close }) => (
              <div class="mx-1 mb-2 flex flex-col gap-0.5">
                <AutoModelRow
                  label={language.t("settings.assistant.model.option.auto")}
                  active={settings.assistant.model() === "auto"}
                  onSelect={() => {
                    settings.assistant.setModel("auto")
                    close()
                  }}
                />
              </div>
            )}
            triggerAs={Button}
            triggerProps={{
              type: "button",
              variant: "ghost",
              size: "normal",
              style: control,
              class: "prompt-pick min-w-0 max-w-[240px] shrink-0 group",
              "aria-label": language.t("command.model.choose"),
            }}
          >
            <span class="truncate">{modelLabel()}</span>
            <Show when={props.variants.length === 0}>
              <Icon name="chevron-down" size="small" class="shrink-0" />
            </Show>
          </ModelSelectorPopover>
          <Show when={props.variants.length > 0}>
            <Select
              size="normal"
              options={variantOptions()}
              current={props.variant ?? "default"}
              label={variantLabel()}
              onSelect={(x) => props.onVariant(x === "default" ? undefined : x)}
              class="prompt-pick prompt-variant max-w-[140px] shrink-0 [&_[data-slot=select-select-trigger-icon]]:text-text-weaker"
              valueClass="truncate text-text-weaker"
              triggerStyle={control}
              variant="ghost"
              triggerProps={{ "aria-label": language.t("command.model.variant.cycle") }}
            />
          </Show>
          <Tooltip
            placement="top"
            value={props.busy ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
          >
            <IconButton
              type="submit"
              form={formID}
              data-action="quick-assistant-submit"
              icon={props.busy ? "stop" : claudeTheme() ? "arrow-up" : "arrow-up-bold"}
              variant="primary"
              iconSize={props.busy ? "normal" : "medium"}
              class="ml-0.5 size-10 shrink-0 rounded-full shadow-xs-border disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!props.busy && (props.loading || !props.ready || !props.text.trim())}
              aria-label={props.busy ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
            />
          </Tooltip>
        </div>
      </form>
    </div>
  )
}
