import "./solid-form-loader"
import { expect, mock, test } from "bun:test"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"

const [params, setParams] = createStore({ id: "session-a" })
const [data, setData] = createStore({
  message: {
    "session-a": [
      {
        id: "assistant-a",
        role: "assistant",
        providerID: "test",
        modelID: "test-model",
        tokens: { total: 341086, input: 3440, output: 447, reasoning: 431, cache: { read: 336768, write: 0 } },
      },
    ],
  } as Record<string, unknown[]>,
  provider: {
    all: [
      {
        id: "test",
        name: "Test Provider",
        models: { "test-model": { name: "Test Model", limit: { context: 1000000 } } },
      },
    ],
  },
  part: {},
})
mock.module("@/context/sync", () => ({ useSync: () => ({ data, session: { get: () => ({ cost: 10.41 }) } }) }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key, intl: () => "en-US" }) }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "desktop", os: "macos" }) }))
mock.module("@/pages/session/session-layout", () => ({ useSessionLayout: () => ({ params }) }))
const { SessionContextUsage } = await import("../../src/components/session-context-usage")

test("panel starts collapsed, expands details, and resets for another session", async () => {
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(() => createComponent(SessionContextUsage, { variant: "panel" }), container)
  try {
    const toggle = () => container.querySelector<HTMLButtonElement>('[data-action="session-context-details-toggle"]')!
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    expect(container.querySelector('[data-slot="session-context-token-summary"]')?.textContent).toBe(
      "(341,086 / 1,000,000)",
    )
    expect(container.textContent).not.toContain("Test Provider")
    toggle().click()
    await Promise.resolve()
    expect(toggle().getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("Test Provider")
    expect(container.textContent).toContain("Test Model")
    setParams("id", "session-b")
    await Promise.resolve()
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("Test Provider")
  } finally {
    dispose()
    container.remove()
  }
})

test("unknown context keeps a compact placeholder instead of fabricated usage", () => {
  setParams("id", "session-a")
  setData("message", "session-a", [])
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(() => createComponent(SessionContextUsage, { variant: "panel" }), container)
  try {
    expect(container.querySelector('[data-slot="session-context-token-summary"]')?.textContent).toBe("(— / —)")
    expect(
      container.querySelector('[data-action="session-context-details-toggle"]')?.getAttribute("aria-expanded"),
    ).toBe("false")
  } finally {
    dispose()
    container.remove()
  }
})
