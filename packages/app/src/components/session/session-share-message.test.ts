import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

test("real message row clamps normalized summaries and expands independently of selection", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [solid({ solid: { generate: "dom", hydratable: false } })],
    resolve: { conditions: ["browser"] },
    ssr: { noExternal: ["solid-js"], resolve: { conditions: ["browser"] } },
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  })
  const container = document.createElement("div")
  document.body.append(container)
  let dispose: (() => void) | undefined
  try {
    const { SessionShareMessage } = await server.ssrLoadModule(
      fileURLToPath(new URL("./session-share-message.tsx", import.meta.url)),
    )
    const { render } = await server.ssrLoadModule("solid-js/web")
    const { createStore } = await server.ssrLoadModule("solid-js/store")
    const markdown = "first\n\nsecond\t" + "long正文".repeat(200)
    const [state, setState] = createStore({ selected: true, disabled: false })
    dispose = render(
      () =>
        SessionShareMessage({
          message: { id: "one", role: "user", markdown },
          get selected() {
            return state.selected
          },
          get disabled() {
            return state.disabled
          },
          roleLabel: "用户",
          expandLabel: "展开",
          collapseLabel: "收起",
          onToggle: () => setState("selected", !state.selected),
        }),
      container,
    )
    const selection = container.querySelector<HTMLElement>('[role="checkbox"]')!
    const button = container.querySelector<HTMLButtonElement>("button")!
    const summary = container.querySelector<HTMLElement>(".session-share-message-summary")!
    const details = container.querySelector<HTMLElement>(".session-share-message-details")!
    expect(summary.textContent).toBe(markdown.replace(/\s+/g, " ").trim())
    expect(summary.textContent!.length).toBeGreaterThan(160)
    expect(selection.contains(button)).toBe(false)
    expect(selection.querySelector("input, button")).toBeNull()
    expect(selection.querySelector('[role="img"]')?.getAttribute("title")).toBe("用户")
    expect(selection.querySelector('[role="img"] svg circle')?.getAttribute("r")).toBe("3.125")
    expect(selection.textContent).not.toContain("用户")
    expect(details.hidden).toBe(true)
    expect(button.getAttribute("aria-controls")).toBe(details.id)
    button.click()
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(button.textContent).toBe("收起")
    expect(details.hidden).toBe(false)
    expect(details.textContent).toBe(markdown)
    expect(state.selected).toBe(true)
    button.click()
    expect(details.hidden).toBe(true)
    expect(state.selected).toBe(true)
    summary.click()
    expect(state.selected).toBe(false)
    expect(container.querySelector(".session-share-message")?.getAttribute("data-selected")).toBe("false")
    selection.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))
    expect(state.selected).toBe(true)
    expect(container.querySelector(".session-share-message")?.getAttribute("data-selected")).toBe("true")
    setState("disabled", true)
    summary.click()
    expect(state.selected).toBe(true)

    // Happy DOM has no line layout engine: verify the actual stylesheet's hard two-line bounds.
    const css = await Bun.file(new URL("./session-share-dialog.css", import.meta.url)).text()
    const rules = css.match(/\.session-share-message-summary\s*\{([^}]+)\}/)![1]
    for (const rule of [
      "min-width: 0",
      "-webkit-line-clamp: 2",
      "line-clamp: 2",
      "white-space: normal",
      "overflow: hidden",
      "max-height: 40px",
      "line-height: 20px",
    ]) {
      expect(rules).toContain(rule)
    }
  } finally {
    dispose?.()
    container.remove()
    await server.close()
  }
})
