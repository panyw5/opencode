import { describe, expect, test } from "bun:test"

const source = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

describe("extension configuration entry", () => {
  test("uses the config page rather than a settings dialog tab", async () => {
    const dialog = await source("../components/dialog-settings.tsx")
    expect(dialog).not.toContain('value="extensions"')
    expect(dialog).not.toContain("SettingsExtensions")
    const config = await source("./config.tsx")
    expect(config).toContain('section === "extensions"')
    expect(config).toContain('jump("extensions")')
    expect(config).toContain("<ConfigExtensionDetail")
    const detail = await source("./config-extension-detail.tsx")
    expect(detail).toContain("<ConfigExtensionSettings")
    expect(detail).toContain("<ConfigExtensionActions")
    expect(config).toContain("extensionSelectionKey(extensionHost.extensions())")
  })

  test("includes the extension entry in the lazy loading shell", async () => {
    const app = await source("../app.tsx")
    expect(app).toContain('id: "extensions"')
    expect(app).toContain('key: "config.extensions.title"')
    expect(app).toContain("CONFIG_FALLBACK_SECTIONS.slice(0, 8)")
    expect(app).toContain("CONFIG_FALLBACK_SECTIONS.slice(8)")
    expect(app).toContain('data-component="config-loading-shell"')
    expect(app).toContain("data-loading-source={props.source}")
    expect(app).toContain('aria-busy="true"')
    expect(app).toContain('source="directory"')
    expect(app).toContain('source="suspense"')
    expect(app).toContain('language.t("common.loading")')
  })
})
