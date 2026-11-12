// Register the JSX transform before dynamically importing production TSX.
import "./solid-form-loader"
import { describe, expect, mock, test } from "bun:test"
import { createComponent, createRenderEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { DEFAULT_GPT_PRO_CONFIG, type GptProConfig } from "@opencode-ai/util/gpt-pro"

// This contract runs only in agent-settings-layout.test.ts's isolated child.
// Contexts and unrelated platform/result services are mocked, not the settings
// components, layout helpers, or their real Button/Select/TextField controls.
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
let platform: { gptPro?: ReturnType<typeof gptApi> } = {}
mock.module("@/context/platform", () => ({ usePlatform: () => platform }))
mock.module("@opencode-ai/ui/gpt-pro-state", () => ({
  gptProStateStore: () => ({
    watchList: () => () => {},
    list: () => [],
    connectionError: () => "",
  }),
}))
mock.module("@opencode-ai/ui/gpt-pro-handoff", () => ({
  handoffGptPro: () => {
    throw new Error("Layout interactions must not hand off a result")
  },
}))
mock.module("@opencode-ai/ui/gpt-pro-result", () => ({
  resolveGptProView: () => {
    throw new Error("Layout interactions must not resolve a result")
  },
}))
mock.module("@opencode-ai/ui/gpt-pro-result-preview", () => ({ GptProResultPreviewDialog: () => null }))
mock.module("@opencode-ai/ui/gpt-pro-error-notice", () => ({ GptProErrorNotice: () => null }))

// The real DirectoryInput requires platform/router providers. Keep a controlled
// input with the same value/disabled/onChange contract, without filesystem access.
mock.module("@/components/directory-input", () => ({ DirectoryInput }))
function DirectoryInput(props: {
  label: string
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const label = document.createElement("label")
  const input = document.createElement("input")
  input.setAttribute("aria-label", props.label)
  input.addEventListener("input", () => props.onChange(input.value))
  createRenderEffect(() => {
    input.value = props.value
    input.disabled = !!props.disabled
  })
  label.append(input)
  return label
}

const { AgentSettingsCard, AgentSettingsDetails, AgentSettingsField, AgentSettingsGrid } = await import(
  "../../src/components/agent-settings-layout"
)
const { DshDefaultsEditor } = await import("../../src/components/dsh-defaults-editor")
const { GptProSettings } = await import("../../src/components/gpt-pro-settings")
const { TextField } = await import("@opencode-ai/ui/text-field")
type DshForm = Parameters<typeof DshDefaultsEditor>[0]["form"]

function mount(children: () => JSX.Element) {
  const container = document.createElement("div")
  document.body.append(container)
  const unmount = render(children, container)
  let disposed = false
  return {
    container,
    dispose: () => {
      if (disposed) return
      disposed = true
      unmount()
      container.remove()
    },
  }
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}
function details(container: HTMLElement, title: string) {
  const result = [...container.querySelectorAll("details")].find(
    (element) => element.querySelector("summary")?.textContent?.trim() === title,
  )
  if (!result) throw new Error(`Missing details ${title}`)
  return result
}
function field(container: HTMLElement, label: string) {
  const result = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!result) throw new Error(`Missing input ${label}`)
  return result
}
function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
function setOpen(element: HTMLDetailsElement, open: boolean) {
  // Happy DOM does not need to emulate summary's browser default action here:
  // exercise the native open state and toggle event, never a component handler.
  element.open = open
  element.dispatchEvent(new Event("toggle"))
}

const initialDsh = (): DshForm => ({
  profile: "headless",
  timeoutSeconds: "120",
  workingDirectory: "/test/workspace",
  permissionMode: "danger-full-access",
  approvalPolicy: "ask",
  additionalWritableRoots: "/test/extra",
  patches: ["model: local-test\n"],
})
function mountDsh() {
  const [form, setForm] = createSignal(initialDsh())
  const changes: DshForm[] = []
  const view = mount(() =>
    createComponent(DshDefaultsEditor, {
      get form() {
        return form()
      },
      disabled: false,
      profiles: ["headless"],
      onChange: (next) => {
        changes.push(next)
        setForm(next)
      },
    }),
  )
  return { ...view, form, changes }
}

function gptApi() {
  let config: GptProConfig = {
    ...DEFAULT_GPT_PRO_CONFIG,
    timeoutMinutes: 12,
    progressIntervalSeconds: 70,
    maxConcurrent: 2,
    maxResidentPages: 4,
  }
  const saves: GptProConfig[] = []
  return {
    saves,
    getConfig: async () => ({ ...config }),
    loginStatus: async () => ({ phase: "idle" }),
    setConfig: async (next: GptProConfig) => {
      config = { ...next }
      saves.push({ ...config })
      return { ...config }
    },
  }
}
function mountGpt() {
  const api = gptApi()
  platform = { gptPro: api }
  const observed: GptProConfig[] = []
  const view = mount(() => createComponent(GptProSettings, { onConfig: (config) => observed.push({ ...config }) }))
  return { ...view, api, observed }
}

describe("agent settings layout contracts", () => {
  test("shared cards retain semantic headings, priority and responsive grid sizing", () => {
    const view = mount(() =>
      createComponent(AgentSettingsGrid, {
        get children() {
          return [
            createComponent(AgentSettingsCard, {
              title: "Primary settings",
              badge: "Enabled",
              priority: "primary",
              get children() {
                return createComponent(AgentSettingsField, { wide: true, children: "Main field" })
              },
            }),
            createComponent(AgentSettingsCard, { title: "Compact settings", size: "compact", children: "Limits" }),
            createComponent(AgentSettingsCard, {
              title: "Wide settings",
              size: "wide",
              get children() {
                return createComponent(AgentSettingsDetails, { title: "Initially open", open: true, children: "Help" })
              },
            }),
          ]
        },
      }),
    )
    try {
      expect(view.container.firstElementChild?.classList.contains("flex-wrap")).toBe(true)
      const cards = [...view.container.querySelectorAll("section")]
      expect(cards).toHaveLength(3)
      expect(cards[0]!.getAttribute("aria-label")).toBe("Primary settings")
      expect(cards[0]!.querySelector("h3")?.textContent).toBe("Primary settings")
      expect(cards[0]!.textContent).toContain("Enabled")
      expect(cards[0]!.classList.contains("bg-surface-raised-base")).toBe(true)
      expect(cards[0]!.classList.contains("flex-[1_1_20rem]")).toBe(true)
      expect(cards[1]!.classList.contains("bg-surface-raised-base")).toBe(true)
      expect(cards[1]!.classList.contains("w-fit")).toBe(true)
      expect(cards[2]!.classList.contains("flex-[1_1_100%]")).toBe(true)
      expect(details(view.container, "Initially open").open).toBe(true)
    } finally {
      view.dispose()
    }
  })

  test("native details preserve the same mounted child input and edited value across toggles", async () => {
    let mounted = 0
    let cleaned = 0
    const changes: string[] = []
    function DraftInput() {
      const [value, setValue] = createSignal("preserved draft")
      onMount(() => mounted++)
      onCleanup(() => cleaned++)
      return createComponent(TextField, {
        label: "Draft input",
        get value() {
          return value()
        },
        onChange: (next) => {
          changes.push(next)
          setValue(next)
        },
      })
    }
    const view = mount(() =>
      createComponent(AgentSettingsDetails, {
        title: "Advanced settings",
        get children() {
          return createComponent(DraftInput, {})
        },
      }),
    )
    try {
      await settle()
      const advanced = details(view.container, "Advanced settings")
      const input = view.container.querySelector("input")!
      expect(advanced.open).toBe(false)
      expect(input.value).toBe("preserved draft")
      expect(mounted).toBe(1)
      setOpen(advanced, true)
      expect(changes).toEqual([])
      typeInto(input, "edited draft")
      setOpen(advanced, false)
      setOpen(advanced, true)
      await settle()
      expect(view.container.querySelector("input")).toBe(input)
      expect(input.value).toBe("edited draft")
      expect(changes).toEqual(["edited draft"])
      expect(mounted).toBe(1)
      expect(cleaned).toBe(0)
    } finally {
      view.dispose()
    }
    expect(cleaned).toBe(1)
  })

  test("DSH full-access warning and core controls remain outside initially collapsed help and YAML", () => {
    const view = mountDsh()
    try {
      const help = details(view.container, "agentSettings.help")
      const advanced = details(view.container, "agentSettings.dsh.advanced")
      expect(help.open).toBe(false)
      expect(advanced.open).toBe(false)
      const warning = view.container.querySelector('[role="note"]')!
      expect(warning.textContent).toBe("config.claws.dsh.defaults.fullAccessWarning")
      expect(warning.closest("details")).toBeNull()
      const permission = view.container.querySelector('[aria-label="config.claws.dsh.defaults.permission"]')!
      expect(permission.closest("details")).toBeNull()
      expect(field(view.container, "config.claws.dsh.defaults.directory").closest("details")).toBeNull()
      expect(view.container.querySelector("textarea")?.closest("details")).toBe(advanced)
      expect(view.form()).toEqual(initialDsh())
      expect(view.changes).toEqual([])
    } finally {
      view.dispose()
    }
  })

  test("DSH expanding YAML never changes values and real text edits still emit the complete form", async () => {
    const view = mountDsh()
    try {
      const advanced = details(view.container, "agentSettings.dsh.advanced")
      const yaml = advanced.querySelector("textarea")!
      expect(yaml.value).toBe(initialDsh().patches[0]!)
      setOpen(advanced, true)
      setOpen(details(view.container, "agentSettings.help"), true)
      await settle()
      expect(view.changes).toEqual([])
      expect(view.form()).toEqual(initialDsh())
      typeInto(yaml, "model: edited-test\n")
      await settle()
      expect(view.changes).toEqual([{ ...initialDsh(), patches: ["model: edited-test\n"] }])
      typeInto(field(view.container, "config.claws.dsh.defaults.directory"), "/test/changed")
      await settle()
      expect(view.changes).toHaveLength(2)
      expect(view.changes[1]).toEqual({
        ...initialDsh(),
        workingDirectory: "/test/changed",
        patches: ["model: edited-test\n"],
      })
      setOpen(advanced, false)
      setOpen(advanced, true)
      expect(advanced.querySelector("textarea")).toBe(yaml)
      expect(yaml.value).toBe("model: edited-test\n")
      expect(view.changes).toHaveLength(2)
    } finally {
      view.dispose()
    }
  })

  test("GPT tutorial starts collapsed and opening it never saves configuration", async () => {
    const view = mountGpt()
    try {
      await settle()
      const guide = details(view.container, "gptPro.guide.title")
      const flow = guide.querySelector('[data-section="gpt-pro-login-flow"]')
      const before = { ...view.observed.at(-1)! }
      expect(view.observed.length).toBeGreaterThan(0)
      expect(guide.open).toBe(false)
      expect(flow).not.toBeNull()
      expect(field(view.container, "gptPro.timeout").closest("details")).toBeNull()
      setOpen(guide, true)
      setOpen(guide, false)
      setOpen(guide, true)
      await settle()
      expect(guide.querySelector('[data-section="gpt-pro-login-flow"]')).toBe(flow)
      expect(field(view.container, "gptPro.timeout").value).toBe("12")
      expect(view.observed.at(-1)).toEqual(before)
      expect(view.api.saves).toEqual([])
    } finally {
      view.dispose()
      platform = {}
    }
  })

  test("GPT parameter change events still auto-save each complete config without opening the tutorial", async () => {
    const view = mountGpt()
    let changed = 0
    const listener = () => changed++
    window.addEventListener("gpt-pro:changed", listener)
    try {
      await settle()
      let expected = { ...view.observed.at(-1)! }
      const edits = [
        ["gptPro.timeout", "timeoutMinutes", 7],
        ["gptPro.progressInterval", "progressIntervalSeconds", 90],
        ["gptPro.maxConcurrent", "maxConcurrent", 3],
        ["gptPro.maxResidentPages", "maxResidentPages", 12],
      ] as const
      for (const [label, key, value] of edits) {
        const input = field(view.container, label)
        expect(input.disabled).toBe(false)
        input.value = String(value)
        input.dispatchEvent(new Event("change", { bubbles: true }))
        await settle()
        expected = { ...expected, [key]: value }
        expect(view.api.saves.at(-1)).toEqual(expected)
        expect(view.observed.at(-1)).toEqual(expected)
        expect(field(view.container, label).value).toBe(String(value))
      }
      expect(view.api.saves).toHaveLength(4)
      expect(changed).toBe(4)
      expect(details(view.container, "gptPro.guide.title").open).toBe(false)
    } finally {
      window.removeEventListener("gpt-pro:changed", listener)
      view.dispose()
      platform = {}
    }
  })
})
