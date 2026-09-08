import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { mainDomain } from "@/pages/layout/extra-agents"
import { authTokenFromCredentials } from "@/utils/server"
import { JsonCodeField } from "./json-code-field"
import { modelConfigPlaceholder, type ModelRow } from "./dialog-custom-provider-form"
import { findModelPresets, type ModelCatalog } from "./model-presets"
import { createModelPresetQuery } from "./model-preset-query"

export function ModelConfigFields(props: {
  providerID: string
  model: ModelRow
  onChange: (index: number, value: string) => void
}) {
  const language = useLanguage()
  const server = useServer()
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const catalog = createModelPresetQuery(() => {
    const connection = server.currentFor(mainDomain)?.http
    if (!connection) return
    return {
      queryKey: ["model-presets", connection?.url, sdk.forDomain(mainDomain).version],
      staleTime: 5 * 60 * 1000,
      retry: 1,
      queryFn: async ({ signal }): Promise<ModelCatalog> => {
        console.info("[model-presets] catalog load start")
        try {
          const headers = new Headers()
          if (connection.password) {
            headers.set(
              "Authorization",
              `Basic ${authTokenFromCredentials({ ...connection, password: connection.password })}`,
            )
          }
          const response = await (platform.fetch ?? fetch)(`${connection.url.replace(/\/$/, "")}/provider/catalog`, {
            headers,
            signal,
          })
          if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`)
          const data: ModelCatalog = await response.json()
          if (
            !data ||
            typeof data !== "object" ||
            Array.isArray(data) ||
            !Object.values(data).every((item) => item && typeof item.models === "object" && item.models !== null)
          ) {
            throw new Error("Invalid model catalog response")
          }
          console.info("[model-presets] catalog loaded", JSON.stringify({ providers: Object.keys(data).length }))
          return data
        } catch (error) {
          console.error("[model-presets] catalog load failed", error)
          throw error
        }
      },
    }
  }, useQueryClient())
  const preset = createMemo(() => findModelPresets(catalog.data ?? {}, props.providerID, props.model.id))
  createEffect(() => {
    console.info(
      "[model-presets] match",
      JSON.stringify({
        provider: props.providerID,
        model: props.model.id,
        source: preset()?.source,
        fields: Object.keys(preset()?.values ?? {}),
      }),
    )
  })

  return (
    <div class="mt-2 grid grid-cols-[minmax(90px,0.55fr)_minmax(0,1.45fr)] items-start gap-2 border-t border-border-weak-base pt-2">
      <For each={props.model.config}>
        {(config, index) => {
          const value = () => preset()?.values[config.key]
          return (
            <>
              <div class="min-w-0 break-all rounded-lg bg-background-base px-2.5 py-2 font-mono text-[11px] leading-5 text-text-weak">
                {config.key}
              </div>
              <div class="flex min-w-0 items-start gap-2" data-model-config-field={config.key}>
                <div class="min-w-0 flex-1">
                  <Show
                    when={config.kind === "json"}
                    fallback={
                      <TextField
                        label={config.key}
                        hideLabel
                        placeholder={modelConfigPlaceholder(config, language.t)}
                        value={config.value}
                        onChange={(value) => props.onChange(index(), value)}
                        validationState={props.model.err.config?.[config.key] ? "invalid" : undefined}
                        error={props.model.err.config?.[config.key]}
                      />
                    }
                  >
                    <JsonCodeField
                      label={config.key}
                      hideLabel
                      placeholder={modelConfigPlaceholder(config, language.t)}
                      value={config.value}
                      onChange={(value) => props.onChange(index(), value)}
                      validationState={props.model.err.config?.[config.key] ? "invalid" : undefined}
                      error={props.model.err.config?.[config.key]}
                    />
                  </Show>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  class="mt-0.5 shrink-0"
                  disabled={value() === undefined}
                  title={
                    catalog.isError
                      ? language.t("provider.custom.models.config.presetFailed")
                      : value() === undefined
                        ? language.t("provider.custom.models.config.noPreset")
                        : `models.dev: ${preset()?.source}\n${value()}`
                  }
                  aria-label={`${language.t("provider.custom.models.config.fillPreset")} ${config.key}`}
                  onClick={() => {
                    const next = value()
                    if (next === undefined) return
                    console.info(
                      "[model-presets] fill",
                      JSON.stringify({
                        model: props.model.id,
                        field: config.key,
                        source: preset()?.source,
                      }),
                    )
                    props.onChange(index(), next)
                  }}
                >
                  {language.t("provider.custom.models.config.fillPreset")}
                </Button>
              </div>
            </>
          )
        }}
      </For>
    </div>
  )
}
