import { For, Show, createMemo } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { useLanguage } from "@/context/language"
import { themePreview } from "./theme-preview"
import { themeOptionCurrent, themeOptionIDs, themeOptionName, themeOptionTarget } from "./theme-options"
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
      <For each={themeOptionIDs(theme.ids(), theme.mode())}>
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
              aria-label={themeOptionName(id, theme.name(id), theme.mode())}
              aria-pressed={themeOptionCurrent(theme.themeId(), theme.mode()) === id}
              disabled={!definition()}
              onClick={() => {
                console.debug(`[settings-appearance] theme selected id=${id} mode=${theme.mode()}`)
                theme.setTheme(themeOptionTarget(id, theme.themeId(), theme.mode()))
              }}
            >
              <div class="theme-card-preview" style={colors()} aria-hidden="true">
                <div data-preview-surface="topbar">
                  <span class="theme-card-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span class="theme-card-tab">preview.ts</span>
                </div>
                <div data-preview-surface="sidebar">
                  <span class="theme-card-project">
                    <span />
                    app
                  </span>
                  <i />
                  <i />
                </div>
                <div data-preview-surface="session">
                  <div class="theme-card-code">
                    <div>
                      <span data-code="keyword">const</span> <span data-code="variable">theme</span>
                      {" ="}
                    </div>
                    <div>
                      {"  "}
                      <span data-code="string">"calm"</span>
                      <span data-code="punctuation">;</span>
                    </div>
                    <div>
                      <span data-code="function">render</span>
                      <span data-code="punctuation">(</span>
                      <span data-code="variable">theme</span>
                      <span data-code="punctuation">);</span>
                    </div>
                    <div>
                      <span data-code="comment">// preview</span>
                    </div>
                  </div>
                  <div class="theme-card-composer">
                    <span />
                    <span class="theme-card-send">&gt;</span>
                  </div>
                </div>
                <div data-preview-surface="popup">
                  <span class="theme-card-status" />
                  Ready
                </div>
              </div>
              <div class="theme-card-caption">
                <span>{themeOptionName(id, theme.name(id), theme.mode())}</span>
                <Show when={themeOptionCurrent(theme.themeId(), theme.mode()) === id}>
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
