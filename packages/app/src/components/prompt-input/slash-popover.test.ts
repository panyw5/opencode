import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

test("mention loading status stays in the fixed header and uses subdued theme chrome", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [solid({ solid: { generate: "ssr" } })],
    resolve: { alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } },
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  })
  try {
    const { PromptPopover } = await server.ssrLoadModule(fileURLToPath(new URL("./slash-popover.tsx", import.meta.url)))
    const { renderToString } = await server.ssrLoadModule("solid-js/web")
    const props = {
      popover: "at",
      atLoading: true,
      atCategory: "all",
      atFlat: [],
      slashFlat: [],
      setPopoverRef: () => {},
      setAtCategory: () => {},
      atKey: () => "",
      setAtActive: () => {},
      onAtSelect: () => {},
      setSlashActive: () => {},
      onSlashSelect: () => {},
      commandKeybind: () => undefined,
      t: (key: string) => key,
    }
    const container = document.createElement("div")
    container.innerHTML = renderToString(() => PromptPopover(props))
    const header = container.querySelector('[data-slot="prompt-at-header"]')!
    expect(header.querySelector('[role="tablist"]')).not.toBeNull()
    expect(header.querySelector('[role="status"]')?.textContent).toBe("prompt.at.loading")
    expect(container.querySelector('[data-prompt-popover-list] [role="status"]')).toBeNull()
    const surface = container.querySelector('[data-component="prompt-popover"]')!
    expect(surface.className).toContain("border-border-weak-base/60")
    expect(surface.className).toContain("shadow-[var(--shadow-lg)]")
    expect(surface.className).not.toContain("border-white")
    expect(surface.className).not.toContain("shadow-lg-border-base")
    const tabs = [...header.querySelectorAll('[role="tab"]')]
    expect(tabs).toHaveLength(5)
    for (const tab of tabs) {
      expect(tab.className).toContain("rounded-full")
      expect(tab.className).toContain("min-h-9")
    }
    const selected = header.querySelector('[aria-selected="true"]')!
    expect(selected.className).toContain("bg-surface-interactive-weak-hover")
    expect(selected.className).toContain("border-border-selected/30")
    const inactive = header.querySelector('[aria-selected="false"]')!
    expect(inactive.className).toContain("hover:bg-surface-base-hover")
    expect(inactive.className).toContain("hover:text-text-strong")

    container.innerHTML = renderToString(() => PromptPopover({ ...props, atLoading: false, atCategory: "external" }))
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[role="tablist"]')).not.toBeNull()
    expect(container.querySelectorAll('[aria-selected="true"]')).toHaveLength(1)
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe("prompt.at.category.external")

    for (const atCategory of ["all", "external"]) {
      container.innerHTML = renderToString(() =>
        PromptPopover({
          ...props,
          atCategory,
          atFlat: [
            ...["gpt-pro", "codex", "claude", "grok", "dsh", "unknown"].map((id) => ({
              type: "consult",
              id,
              name: id,
              display: id,
            })),
            { type: "agent", name: "build", display: "Build" },
          ],
        }),
      )
      const rows = [...container.querySelectorAll("[data-prompt-popover-list] button")]
      expect(rows).toHaveLength(7)
      for (const [index, icon] of ["openai", "openai", "anthropic", "xai", "deepseek", "synthetic"].entries()) {
        const svg = rows[index].querySelector('[data-component="provider-icon"]')!
        expect(svg).not.toBeNull()
        expect(svg.querySelector("use")?.getAttribute("href")).toEndWith(`#${icon}`)
        expect(svg.getAttribute("aria-hidden")).toBe("true")
        expect(svg.getAttribute("class")).toContain("size-4")
        expect(rows[index].textContent).toContain("prompt.at.badge.consult")
      }
      expect(rows[6].querySelector('[data-component="provider-icon"]')).toBeNull()
      expect(rows[6].textContent).toBe("@build")
    }

    container.innerHTML = renderToString(() => PromptPopover({ ...props, popover: "slash" }))
    expect(container.querySelector('[data-slot="prompt-at-header"]')).toBeNull()
  } finally {
    await server.close()
  }
})
