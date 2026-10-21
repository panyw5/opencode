import { For, Show, createMemo } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { useLanguage } from "@/context/language"
import { themePreview } from "./theme-preview"
import "./settings-theme-cards.css"

export function SettingsThemeCards() {
  const theme = useTheme()
  const language = useLanguage()

  return (
    <div
      data-action="settings-theme"
      class="settings-theme-grid"
      role="group"
      aria-label={language.t("settings.general.row.theme.title")}
    >
      <For each={theme.ids()}>
        {(id) => {
          const definition = () => theme.themes()[id]
          const colors = createMemo(() => {
            const value = definition()
            return value ? themePreview(value, theme.mode()) : undefined
          })
          return (
            <button
              type="button"
              data-component="settings-theme-card"
              data-theme-id={id}
              aria-label={theme.name(id)}
              aria-pressed={theme.themeId() === id}
              disabled={!definition()}
              onClick={() => {
                console.debug(`[settings-appearance] theme selected id=${id} mode=${theme.mode()}`)
                theme.setTheme(id)
              }}
            >
              <div class="theme-card-preview" style={colors()} aria-hidden="true">
                <div data-preview-surface="topbar">
                  <span class="theme-card-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
                <div data-preview-surface="sidebar">
                  <i />
                  <i />
                  <i />
                </div>
                <div data-preview-surface="session">
                  <i />
                  <i />
                  <i />
                  <div class="theme-card-composer" />
                </div>
                <div data-preview-surface="popup">
                  <i />
                  <i />
                </div>
              </div>
              <div class="theme-card-caption">
                <span>{theme.name(id)}</span>
                <Show when={theme.themeId() === id}>
                  <Icon name="circle-check" size="small" />
                </Show>
              </div>
            </button>
          )
        }}
      </For>
    </div>
  )
}
