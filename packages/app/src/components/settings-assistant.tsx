import { Select } from "@opencode-ai/ui/select"
import { showToast } from "@opencode-ai/ui/toast"
import type { Component } from "solid-js"
import { createMemo, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useSettings } from "@/context/settings"
import { useGlobalSync } from "@/context/global-sync"
import { SettingsList } from "./settings-list"

type ModelRef = { providerID: string; modelID: string }
type AssistantModelValue = ModelRef | "auto" | "disabled"
type SmallModelValue = ModelRef | undefined

type Option<T> = {
  value: T
  label: string
}

export const SettingsAssistant: Component = () => {
  const language = useLanguage()
  const models = useModels()
  const settings = useSettings()
  const globalSync = useGlobalSync()
  const [savingSmall, setSavingSmall] = createSignal(false)

  const modelOptions = createMemo(() =>
    models
      .list()
      .map((item) => ({
        value: { providerID: item.provider.id, modelID: item.id } satisfies ModelRef,
        label: `${item.provider.name} - ${item.name}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  )

  const assistantOff: Option<"disabled"> = {
    value: "disabled",
    label: language.t("settings.assistant.model.option.disabled"),
  }
  const assistantAuto: Option<"auto"> = {
    value: "auto",
    label: language.t("settings.assistant.model.option.auto"),
  }
  const assistantOptions = createMemo(() => [assistantOff, assistantAuto, ...modelOptions()])

  const assistantCurrent = createMemo(() => {
    const selected = settings.assistant.model()
    if (selected === "disabled") return assistantOff
    if (selected === "auto") return assistantAuto
    return (
      assistantOptions().find(
        (item) =>
          typeof item.value === "object" &&
          item.value.providerID === selected.providerID &&
          item.value.modelID === selected.modelID,
      ) ?? {
        value: selected,
        label: `${selected.providerID}/${selected.modelID}`,
      }
    )
  })

  const smallAuto: Option<undefined> = {
    value: undefined,
    label: language.t("settings.assistant.smallModel.option.auto"),
  }

  const smallConfigured = createMemo((): ModelRef | undefined => {
    const raw = globalSync.data.config.small_model
    if (typeof raw !== "string" || !raw.trim()) return undefined
    const slash = raw.indexOf("/")
    if (slash <= 0) return undefined
    return {
      providerID: raw.slice(0, slash),
      modelID: raw.slice(slash + 1),
    }
  })

  const smallOptions = createMemo(() => {
    const configured = smallConfigured()
    const list = modelOptions()
    if (
      configured &&
      !list.some((item) => item.value.providerID === configured.providerID && item.value.modelID === configured.modelID)
    ) {
      return [
        smallAuto,
        {
          value: configured,
          label: `${configured.providerID}/${configured.modelID}`,
        },
        ...list,
      ]
    }
    return [smallAuto, ...list]
  })

  const smallCurrent = createMemo(() => {
    const selected = smallConfigured()
    if (!selected) return smallAuto
    return (
      smallOptions().find(
        (item) =>
          typeof item.value === "object" &&
          item.value.providerID === selected.providerID &&
          item.value.modelID === selected.modelID,
      ) ?? {
        value: selected,
        label: `${selected.providerID}/${selected.modelID}`,
      }
    )
  })

  const saveSmallModel = async (value: SmallModelValue) => {
    if (savingSmall()) return
    const next = value && typeof value === "object" ? `${value.providerID}/${value.modelID}` : ""
    const current =
      typeof globalSync.data.config.small_model === "string" ? globalSync.data.config.small_model : ""
    if (next === current) return

    setSavingSmall(true)
    try {
      // Empty string clears the override (backend maps "" → undefined for small_model).
      await globalSync.updateConfig({ small_model: next }, { refreshProviders: false })

      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.assistant.smallModel.toast.saved"),
        description: next || language.t("settings.assistant.smallModel.option.auto"),
      })
    } catch (err: unknown) {
      showToast({
        title: language.t("settings.assistant.smallModel.toast.failed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSavingSmall(false)
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
              <Select
                data-action="settings-assistant-model"
                options={assistantOptions()}
                current={assistantCurrent()}
                value={(item) =>
                  item.value === "disabled"
                    ? "disabled"
                    : item.value !== "auto"
                      ? `${item.value.providerID}/${item.value.modelID}`
                      : "auto"
                }
                label={(item) => item.label}
                onSelect={(item) => settings.assistant.setModel(item?.value as AssistantModelValue)}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                triggerStyle={{ "min-width": "260px" }}
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
            <div class="flex w-full justify-end sm:w-auto sm:shrink-0">
              <Select
                data-action="settings-assistant-small-model"
                options={smallOptions()}
                current={smallCurrent()}
                value={(item) => (item.value ? `${item.value.providerID}/${item.value.modelID}` : "auto")}
                label={(item) => item.label}
                onSelect={(item) => {
                  void saveSmallModel(item?.value as SmallModelValue)
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                triggerStyle={{ "min-width": "260px" }}
              />
            </div>
          </div>
        </SettingsList>
      </div>
    </div>
  )
}
