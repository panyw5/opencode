import { type Component, Show, createMemo, onCleanup, onMount } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Icon, type IconPack } from "@opencode-ai/ui/icon"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useLanguage } from "@/context/language"
import { useSettings, monoFontFamily } from "@/context/settings"
import { SettingsList } from "./settings-list"
import { SettingsRow } from "./settings-row"
import { Link } from "./link"
import { SettingsThemeCards } from "./settings-theme-cards"

let font: Promise<typeof import("@opencode-ai/ui/font-loader")> | undefined

function loadFont() {
  font ??= import("@opencode-ai/ui/font-loader")
  return font
}

export const SettingsAppearance: Component<{ embedded?: boolean }> = (props) => {
  const theme = useTheme()
  const language = useLanguage()
  const settings = useSettings()
  let previewPending: ReturnType<typeof setTimeout> | undefined
  onMount(() => {
    console.debug("[settings-appearance] loading themes")
    void theme
      .loadThemes()
      .then(() => {
        console.debug("[settings-appearance] themes loaded count=" + theme.ids().length)
      })
      .catch((error) => console.error("[settings-appearance] theme loading failed", error))
  })
  onCleanup(() => {
    clearTimeout(previewPending)
    theme.cancelPreview()
  })
  const iconPackOptions = createMemo(() =>
    (
      [
        { value: "phosphor", labelKey: "settings.general.row.iconPack.option.phosphor" },
        { value: "lucide", labelKey: "settings.general.row.iconPack.option.lucide" },
        { value: "tabler", labelKey: "settings.general.row.iconPack.option.tabler" },
        { value: "legacy", labelKey: "settings.general.row.iconPack.option.legacy" },
      ] as const
    ).map((option) => ({
      value: option.value as IconPack,
      label: language.t(option.labelKey),
    })),
  )

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const fontOptions = [
    { value: "ibm-plex-mono", label: "font.option.ibmPlexMono" },
    { value: "cascadia-code", label: "font.option.cascadiaCode" },
    { value: "fira-code", label: "font.option.firaCode" },
    { value: "hack", label: "font.option.hack" },
    { value: "inconsolata", label: "font.option.inconsolata" },
    { value: "intel-one-mono", label: "font.option.intelOneMono" },
    { value: "iosevka", label: "font.option.iosevka" },
    { value: "jetbrains-mono", label: "font.option.jetbrainsMono" },
    { value: "meslo-lgs", label: "font.option.mesloLgs" },
    { value: "roboto-mono", label: "font.option.robotoMono" },
    { value: "source-code-pro", label: "font.option.sourceCodePro" },
    { value: "ubuntu-mono", label: "font.option.ubuntuMono" },
    { value: "geist-mono", label: "font.option.geistMono" },
  ] as const
  const fontOptionsList = [...fontOptions]

  const AppearanceSection = () => (
    <div class="flex flex-col gap-1">
      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.font.title")}
          description={language.t("settings.general.row.font.description")}
        >
          <Select
            data-action="settings-font"
            options={fontOptionsList}
            current={fontOptionsList.find((o) => o.value === settings.appearance.font())}
            value={(o) => o.value}
            label={(o) => language.t(o.label)}
            onHighlight={(option) => {
              void loadFont().then((x) => x.ensureMonoFont(option?.value))
            }}
            onSelect={(option) => option && settings.appearance.setFont(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "font-family": monoFontFamily(settings.appearance.font()), "min-width": "180px" }}
          >
            {(option) => (
              <span style={{ "font-family": monoFontFamily(option?.value) }}>
                {option ? language.t(option.label) : ""}
              </span>
            )}
          </Select>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.iconPack.title")}
          description={language.t("settings.general.row.iconPack.description")}
        >
          <Select
            data-action="settings-icon-pack"
            options={iconPackOptions()}
            current={iconPackOptions().find((o) => o.value === settings.appearance.iconPack())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && settings.appearance.setIconPack(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "180px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.fontSize.title")}
          description={language.t("settings.general.row.fontSize.description")}
        >
          <div data-action="settings-font-size" class="flex items-center gap-2">
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                const size = settings.appearance.fontSize()
                if (size > 10) settings.appearance.setFontSize(size - 1)
              }}
              disabled={settings.appearance.fontSize() <= 10}
              aria-label={language.t("settings.general.row.fontSize.decrease")}
            >
              -
            </Button>
            <span class="text-14-regular text-text-strong min-w-[48px] text-center">
              {settings.appearance.fontSize()}px
            </span>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                const size = settings.appearance.fontSize()
                if (size < 24) settings.appearance.setFontSize(size + 1)
              }}
              disabled={settings.appearance.fontSize() >= 24}
              aria-label={language.t("settings.general.row.fontSize.increase")}
            >
              +
            </Button>
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.contentWidth.title")}
          description={language.t("settings.general.row.contentWidth.description")}
        >
          <div data-action="settings-content-width" class="flex items-center gap-2">
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                const width = settings.appearance.contentWidth()
                const opts = [200, 250, 300, 350, 400]
                const idx = opts.indexOf(width)
                if (idx > 0) {
                  const next = opts[idx - 1]
                  console.debug(`[settings] contentWidth decrease from=${width} to=${next}`)
                  settings.appearance.setContentWidth(next)
                }
              }}
              disabled={settings.appearance.contentWidth() <= 200}
              aria-label={language.t("settings.general.row.contentWidth.decrease")}
            >
              -
            </Button>
            <span class="text-14-regular text-text-strong min-w-[80px] text-center">
              {settings.appearance.contentWidth() === 200 && language.t("settings.general.row.contentWidth.narrow")}
              {settings.appearance.contentWidth() === 250 && language.t("settings.general.row.contentWidth.medium")}
              {settings.appearance.contentWidth() === 300 && language.t("settings.general.row.contentWidth.wide")}
              {settings.appearance.contentWidth() === 350 && language.t("settings.general.row.contentWidth.extraWide")}
              {settings.appearance.contentWidth() === 400 && language.t("settings.general.row.contentWidth.fullWidth")}
            </span>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                const width = settings.appearance.contentWidth()
                const opts = [200, 250, 300, 350, 400]
                const idx = opts.indexOf(width)
                if (idx >= 0 && idx < opts.length - 1) {
                  const next = opts[idx + 1]
                  console.debug(`[settings] contentWidth increase from=${width} to=${next}`)
                  settings.appearance.setContentWidth(next)
                }
              }}
              disabled={settings.appearance.contentWidth() >= 400}
              aria-label={language.t("settings.general.row.contentWidth.increase")}
            >
              +
            </Button>
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <Select
            data-action="settings-color-scheme"
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              clearTimeout(previewPending)
              console.debug("[settings-appearance] scheme selected scheme=" + option.value)
              theme.setColorScheme(option.value)
            }}
            onHighlight={(option) => {
              clearTimeout(previewPending)
              if (!option) return
              previewPending = setTimeout(() => {
                theme.previewColorScheme(option.value)
              }, 80)
              return () => {
                clearTimeout(previewPending)
              }
            }}
            onOpenChange={(open) => {
              if (open) return
              clearTimeout(previewPending)
              theme.cancelPreview()
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "220px" }}
          />
        </SettingsRow>
      </SettingsList>
      <section class="flex flex-col gap-4 py-6">
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong">{language.t("settings.general.row.theme.title")}</h3>
          <p class="text-12-regular text-text-weak">
            {language.t("settings.appearance.preview.description")}{" "}
            <Link href="https://opencode.ai/docs/themes/">{language.t("common.learnMore")}</Link>
          </p>
        </div>
        <SettingsThemeCards />
      </section>
    </div>
  )

  return (
    <div
      data-settings-appearance
      class="flex flex-col"
      classList={{ "h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10": !props.embedded }}
    >
      <Show
        when={!props.embedded}
        fallback={
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.appearance")}</h3>
        }
      >
        <div class="pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.general.section.appearance")}</h2>
        </div>
      </Show>
      <AppearanceSection />
    </div>
  )
}
