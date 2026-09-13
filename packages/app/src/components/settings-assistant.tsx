import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { showToast } from "@opencode-ai/ui/toast"
import type { Component } from "solid-js"
import { createMemo, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useGlobalSync } from "@/context/global-sync"
import { ModelSelectorPopover, parseModelRef, useBoundModelState } from "./dialog-select-model"
import { SettingsList } from "./settings-list"

type ModelRef = { providerID: string; modelID: string }
type AssistantModelValue = ModelRef | "auto" | "disabled"
type SmallModelValue = ModelRef | undefined
const unsetSmallModel = Symbol("unset-small-model")

const PinnedOptionRow: Component<{
  label: string
  active: boolean
  dataAction: string
  onSelect: () => void
}> = (props) => (
  <button
    type="button"
    data-action={props.dataAction}
    onClick={props.onSelect}
    class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-13-regular text-text-strong transition-colors hover:bg-[var(--list-item-hover-bg)]"
  >
    <span class="truncate">{props.label}</span>
    <Show when={props.active}>
      <Icon name="check-small" size="small" class="shrink-0 text-icon-strong-base" />
    </Show>
  </button>
)

const AssistantModelSelector: Component<{
  value: AssistantModelValue
  onChange: (next: AssistantModelValue) => void
}> = (props) => {
  const language = useLanguage()
  const model = useBoundModelState({
    value: () => (typeof props.value === "object" ? `${props.value.providerID}/${props.value.modelID}` : ""),
    onChange: (next) => {
      const parsed = parseModelRef(next)
      if (!parsed) return
      props.onChange(parsed)
    },
  })
  const current = () => model.current()

  const label = () => {
    const value = props.value
    if (value === "disabled") return language.t("settings.assistant.model.option.disabled")
    if (value === "auto") return language.t("settings.assistant.model.option.auto")
    const item = current()
    if (item) return `${item.provider.name} - ${item.name}`
    return `${value.providerID}/${value.modelID}`
  }

  return (
    <ModelSelectorPopover
      model={model}
      showSummary={typeof props.value === "object"}
      header={({ close }) => (
        <div class="mx-1 mb-2 flex flex-col gap-0.5">
          <PinnedOptionRow
            label={language.t("settings.assistant.model.option.disabled")}
            active={props.value === "disabled"}
            dataAction="settings-assistant-model-disabled"
            onSelect={() => {
              props.onChange("disabled")
              close()
            }}
          />
          <PinnedOptionRow
            label={language.t("settings.assistant.model.option.auto")}
            active={props.value === "auto"}
            dataAction="settings-assistant-model-auto"
            onSelect={() => {
              props.onChange("auto")
              close()
            }}
          />
        </div>
      )}
      triggerAs={Button}
      triggerProps={{
        type: "button",
        variant: "secondary",
        size: "small",
        "data-action": "settings-assistant-model",
        class: "min-w-[260px] justify-between gap-2",
      }}
    >
      <div class="flex min-w-0 items-center gap-2">
        <Show when={current()?.provider.id}>
          <ProviderIcon id={current()!.provider.id} class="size-4 shrink-0" />
        </Show>
        <span class="truncate">{label()}</span>
      </div>
      <Icon name="selector" size="small" class="shrink-0 text-text-weak" />
    </ModelSelectorPopover>
  )
}

const SmallModelSelector: Component<{
  value: SmallModelValue
  saving: boolean
  onChange: (next: SmallModelValue) => void
}> = (props) => {
  const language = useLanguage()
  const model = useBoundModelState({
    value: () => (props.value ? `${props.value.providerID}/${props.value.modelID}` : ""),
    onChange: (next) => {
      // An empty next (cleared from the list) means falling back to auto.
      props.onChange(parseModelRef(next))
    },
  })
  const current = () => model.current()

  const label = () => {
    const value = props.value
    if (!value) return language.t("settings.assistant.smallModel.option.auto")
    const item = current()
    if (item) return `${item.provider.name} - ${item.name}`
    return `${value.providerID}/${value.modelID}`
  }

  return (
    <ModelSelectorPopover
      model={model}
      showSummary={!!props.value}
      header={({ close }) => (
        <div class="mx-1 mb-2 flex flex-col gap-0.5">
          <PinnedOptionRow
            label={language.t("settings.assistant.smallModel.option.auto")}
            active={!props.value}
            dataAction="settings-assistant-small-model-auto"
            onSelect={() => {
              props.onChange(undefined)
              close()
            }}
          />
        </div>
      )}
      triggerAs={Button}
      triggerProps={{
        type: "button",
        variant: "secondary",
        size: "small",
        "data-action": "settings-assistant-small-model",
        class: "min-w-[260px] justify-between gap-2",
        disabled: props.saving,
      }}
    >
      <div class="flex min-w-0 items-center gap-2">
        <Show when={current()?.provider.id}>
          <ProviderIcon id={current()!.provider.id} class="size-4 shrink-0" />
        </Show>
        <span class="truncate">{label()}</span>
      </div>
      <Icon name="selector" size="small" class="shrink-0 text-text-weak" />
    </ModelSelectorPopover>
  )
}

export const SettingsAssistant: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const globalSync = useGlobalSync()
  const [savingSmall, setSavingSmall] = createSignal(false)
  const [pendingSmall, setPendingSmall] = createSignal<SmallModelValue | typeof unsetSmallModel>(unsetSmallModel)
  let smallSaveInFlight = false

  const smallConfigured = createMemo((): ModelRef | undefined => {
    const pending = pendingSmall()
    if (pending !== unsetSmallModel) return pending

    const raw = globalSync.data.config.small_model
    if (typeof raw !== "string" || !raw.trim()) return undefined
    const slash = raw.indexOf("/")
    if (slash <= 0) return undefined
    return {
      providerID: raw.slice(0, slash),
      modelID: raw.slice(slash + 1),
    }
  })

  const saveSmallModel = async (value: SmallModelValue) => {
    if (smallSaveInFlight || savingSmall()) {
      console.debug("[settings-assistant] small model selection ignored while saving")
      return
    }
    const next = value && typeof value === "object" ? `${value.providerID}/${value.modelID}` : ""
    const current =
      typeof globalSync.data.config.small_model === "string" ? globalSync.data.config.small_model : ""
    console.debug(`[settings-assistant] small model selected next=${next || "auto"} current=${current || "auto"}`)
    if (next === current) return

    setPendingSmall(value)
    smallSaveInFlight = true
    setSavingSmall(true)
    console.debug(`[settings-assistant] small model save started value=${next || "auto"}`)
    try {
      // Empty string clears the override (backend maps "" → undefined for small_model).
      await globalSync.updateConfig({ small_model: next }, { refreshProviders: false })
      setPendingSmall(unsetSmallModel)
      console.debug(`[settings-assistant] small model save succeeded value=${next || "auto"}`)

      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.assistant.smallModel.toast.saved"),
        description: next || language.t("settings.assistant.smallModel.option.auto"),
      })
    } catch (err: unknown) {
      setPendingSmall(unsetSmallModel)
      console.debug("[settings-assistant] small model save failed; reverted optimistic selection", err)
      showToast({
        title: language.t("settings.assistant.smallModel.toast.failed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      smallSaveInFlight = false
      setSavingSmall(false)
      console.debug("[settings-assistant] small model save finished")
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-6 pt-6 max-w-[720px]">
        <div class="flex flex-col gap-1">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.assistant.title")}</h2>
          <p class="text-14-regular text-text-weak">{language.t("settings.assistant.description")}</p>
        </div>

        <SettingsList>
          <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-14-medium text-text-strong">{language.t("settings.assistant.model.title")}</span>
              <span class="text-12-regular text-text-weak">{language.t("settings.assistant.model.description")}</span>
            </div>
            <div class="flex w-full justify-end sm:w-auto sm:shrink-0">
              <AssistantModelSelector
                value={settings.assistant.model()}
                onChange={(next) => settings.assistant.setModel(next)}
              />
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-14-medium text-text-strong">{language.t("settings.assistant.smallModel.title")}</span>
              <span class="text-12-regular text-text-weak">
                {language.t("settings.assistant.smallModel.description")}
              </span>
            </div>
            <div class="flex w-full items-center justify-end gap-2 sm:w-auto sm:shrink-0">
              <Show when={savingSmall()}>
                <span class="text-12-regular text-text-weak">{language.t("common.saving")}</span>
              </Show>
              <SmallModelSelector
                value={smallConfigured()}
                saving={savingSmall()}
                onChange={(next) => void saveSmallModel(next)}
              />
            </div>
          </div>
        </SettingsList>
      </div>
    </div>
  )
}
