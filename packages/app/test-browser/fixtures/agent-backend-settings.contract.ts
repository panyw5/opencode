// Install the JSX transform before dynamically importing any production TSX.
import "./solid-form-loader"
import { describe, expect, mock, test } from "bun:test"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type {
  AgentBackendProbeResponse,
  AgentBackendStatusResponse,
  Config,
  OpencodeClient,
} from "@opencode-ai/sdk/v2/client"
import type { AdvisorID } from "../../src/components/agent-backend-settings"

// This file runs only through agent-backend-settings.test.ts's isolated child.
// Do not import the context modules: loading their real exports pulls in the
// application/router/plugin graph even though only AgentBackendSettings renders.
mock.module("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
mock.module("@/context/global-sdk", () => ({
  useGlobalSDK: () => {
    throw new Error("AgentBackendSettings must use its injected client")
  },
}))
mock.module("@/context/server", () => ({
  useServer: () => {
    throw new Error("AgentBackendSettings must not require a server provider")
  },
}))
mock.module("@/pages/layout/extra-agents", () => ({ mainDomain: "main" }))

// Render the real component and real UI controls, never a copy of its handlers.
const { AgentBackendSettings } = await import("../../src/components/agent-backend-settings")

type AcpConfig = Extract<NonNullable<NonNullable<Config["agent_backends"]>["claude"]>, { type: "acp" }>
type ProbeRequest = {
  advisor: AdvisorID
  config: AcpConfig
  message?: boolean
  authMethod?: string
}
type RequestOptions = { signal: AbortSignal; throwOnError: boolean }
type ProbeCall = { request: ProbeRequest; options: RequestOptions }

const ready = (): AgentBackendProbeResponse => ({ status: "ready", message: "Adapter ready", authMethods: [] })
const status = (): AgentBackendStatusResponse => ({
  target: "local-test-server",
  platform: "darwin",
  arch: "arm64",
  directory: "/test/agent-backends",
  node: "v22.0.0",
  npm: "10.0.0",
  adapters: [],
})
const backend = (over: Partial<AcpConfig> = {}): AcpConfig => ({
  type: "acp",
  command: ["/test/custom-adapter", "--acp"],
  env: {},
  permission: "deny",
  ...over,
})
const configuration = (acp = backend()): Config => ({
  agent_backends: { claude: acp, codex: { type: "cli-json" } },
  external_agents: { claude: { enabled: false }, codex: { enabled: true } },
  pi: { enabled: false },
})
// draft() deliberately normalizes blank optional fields and environment.
const normalized = (acp = backend()): AcpConfig => ({
  ...acp,
  env: acp.env ?? {},
  model: acp.model,
  mode: acp.mode,
  permission: acp.permission ?? "deny",
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function clientMock(
  options: {
    probe?: (request: ProbeRequest, options: RequestOptions) => Promise<AgentBackendProbeResponse>
    status?: () => Promise<AgentBackendStatusResponse>
  } = {},
) {
  const calls: ProbeCall[] = []
  const inspections: RequestOptions[] = []
  const client = {
    agentBackend: {
      status: async (_: unknown, requestOptions: RequestOptions) => {
        inspections.push(requestOptions)
        return { data: await (options.status?.() ?? Promise.resolve(status())) }
      },
      probe: async (request: ProbeRequest, requestOptions: RequestOptions) => {
        calls.push({ request, options: requestOptions })
        // Intentionally ignore signal cancellation: the component must reject
        // stale successes even when the transport resolves after being aborted.
        return { data: await (options.probe?.(request, requestOptions) ?? Promise.resolve(ready())) }
      },
      prepare: () => {
        throw new Error("Saving must not prepare an adapter installation")
      },
      commit: () => {
        throw new Error("Saving must not commit an adapter installation")
      },
    },
  } as unknown as OpencodeClient
  return { client, calls, inspections }
}

function mount(options: {
  client: OpencodeClient
  advisor?: AdvisorID
  config?: Config
  remote?: boolean
  onSave?: (patch: Partial<Config>) => Promise<unknown>
  cliSettings?: () => HTMLElement
}) {
  const [props, setProps] = createSignal({
    advisor: options.advisor ?? ("claude" as AdvisorID),
    config: options.config ?? configuration(),
    client: options.client,
  })
  const saves: Partial<Config>[] = []
  const container = document.createElement("div")
  document.body.append(container)
  const unmount = render(
    () =>
      createComponent(AgentBackendSettings, {
        get advisor() {
          return props().advisor
        },
        get config() {
          return props().config
        },
        get client() {
          return props().client
        },
        remote: options.remote,
        cliSettings: options.cliSettings,
        onSave: async (patch) => {
          saves.push(patch)
          return options.onSave?.(patch)
        },
      }),
    container,
  )
  let disposed = false
  return {
    container,
    saves,
    update: (patch: Partial<ReturnType<typeof props>>) => setProps((current) => ({ ...current, ...patch })),
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
const key = (name: string) => (name.includes(".") ? name : `agentBackend.${name}`)
const maybeButton = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === key(name))
const button = (container: HTMLElement, name: string) => {
  const result = maybeButton(container, name)
  if (!result) throw new Error(`Missing button ${key(name)}`)
  return result
}
const select = (container: HTMLElement, name: string) => {
  const result = [...container.querySelectorAll<HTMLSelectElement>("select")].find(
    (item) =>
      item.getAttribute("aria-label") === key(name) || item.closest("label")?.textContent?.trim().startsWith(key(name)),
  )
  if (!result) throw new Error(`Missing select ${key(name)}`)
  return result
}
const choose = (element: HTMLSelectElement, value: string) => {
  element.value = value
  element.dispatchEvent(new Event("change", { bubbles: true }))
}
const field = (container: HTMLElement, name: string) => {
  const row = [...container.querySelectorAll<HTMLElement>('[data-component="input"]')].find(
    (item) => item.querySelector("label")?.textContent?.trim() === key(name),
  )
  const result = row?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")
  if (!result) throw new Error(`Missing field ${key(name)}`)
  const details = result.closest("details")
  if (details) details.open = true
  return result
}
const typeInto = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  element.value = value
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
const alerts = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="alert"]')].map((item) => item.textContent).join("\n")

async function manuallyTest(container: HTMLElement) {
  button(container, "test").click()
  await settle()
  expect(container.textContent).toContain("agentBackend.ready")
}

describe("AgentBackendSettings save and probe contracts", () => {
  test("CLI content is only mounted for the selected CLI transport without saving", async () => {
    const mock = clientMock()
    let mounts = 0
    const view = mount({
      client: mock.client,
      cliSettings: () => {
        mounts++
        const section = document.createElement("section")
        section.textContent = "CLI parameters and actions"
        return section
      },
    })
    try {
      await settle()
      expect(mounts).toBe(0)
      expect(view.container.textContent).not.toContain("CLI parameters and actions")
      choose(select(view.container, "transport"), "cli-json")
      expect(mounts).toBe(1)
      expect(view.container.textContent).toContain("CLI parameters and actions")
      choose(select(view.container, "transport"), "acp")
      expect(view.container.textContent).not.toContain("CLI parameters and actions")
      expect(view.saves).toHaveLength(0)
      expect(mock.calls).toHaveLength(0)
    } finally {
      view.dispose()
    }
  })
  test("runtime and advanced details start collapsed without hiding the connection or changing the draft", async () => {
    const mock = clientMock()
    const view = mount({ client: mock.client })
    try {
      await settle()
      const details = [...view.container.querySelectorAll("details")]
      const advanced = details.find((item) => item.querySelector("summary")?.textContent === "agentBackend.advanced")!
      const runtime = details.find(
        (item) => item.querySelector("summary")?.textContent === "agentSettings.runtimeDetails",
      )!
      expect(advanced.open).toBe(false)
      expect(runtime.open).toBe(false)
      expect(select(view.container, "transport").closest("details")).toBeNull()
      expect(field(view.container, "command").closest("details")).toBeNull()
      advanced.open = true
      runtime.open = true
      expect(runtime.textContent).toContain("/test/agent-backends")
      expect(mock.calls).toHaveLength(0)
      expect(view.saves).toHaveLength(0)
      advanced.open = false
      runtime.open = false
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls[0]!.request.config).toEqual(normalized())
      expect(view.saves).toHaveLength(1)
    } finally {
      view.dispose()
    }
  })

  test("an untested ACP save probes without a model message, waits for ready, then saves once", async () => {
    const inspecting = deferred<AgentBackendStatusResponse>()
    const probing = deferred<AgentBackendProbeResponse>()
    const saving = deferred<void>()
    const events: string[] = []
    const mock = clientMock({
      status: () => inspecting.promise,
      probe: async () => {
        events.push("probe")
        const result = await probing.promise
        events.push("ready")
        return result
      },
    })
    const current = configuration()
    const view = mount({
      client: mock.client,
      config: current,
      onSave: () => {
        events.push("save")
        return saving.promise
      },
    })
    try {
      expect(button(view.container, "activate").disabled).toBe(true)
      inspecting.resolve(status())
      await settle()
      expect(mock.calls).toHaveLength(0)
      expect(button(view.container, "activate").disabled).toBe(false)
      button(view.container, "activate").click()
      button(view.container, "activate").click()
      expect(mock.calls).toHaveLength(1)
      expect(mock.calls[0]!.request).toEqual({ advisor: "claude", config: normalized(), message: false })
      expect(mock.calls[0]!.options.throwOnError).toBe(true)
      expect(mock.calls[0]!.options.signal.aborted).toBe(false)
      expect(button(view.container, "activate").disabled).toBe(true)
      expect(view.saves).toHaveLength(0)
      probing.resolve(ready())
      await settle()
      expect(events).toEqual(["probe", "ready", "save"])
      expect(view.saves).toEqual([
        {
          agent_backends: { ...current.agent_backends, claude: normalized() },
          external_agents: {
            ...current.external_agents,
            claude: { ...current.external_agents?.claude, enabled: true },
          },
        },
      ])
      expect(button(view.container, "activate").disabled).toBe(true)
      button(view.container, "activate").click()
      expect(view.saves).toHaveLength(1)
      saving.resolve()
      await settle()
      expect(button(view.container, "activate").disabled).toBe(false)
      expect(view.container.textContent).toContain("agentBackend.saved")
    } finally {
      saving.resolve()
      probing.resolve(ready())
      inspecting.resolve(status())
      view.dispose()
    }
  })

  test("saving an unchanged, manually ready ACP draft does not probe again", async () => {
    const mock = clientMock()
    const view = mount({ client: mock.client })
    try {
      await settle()
      await manuallyTest(view.container)
      expect(mock.calls).toHaveLength(1)
      expect(mock.calls[0]!.request.message).toBe(false)
      expect(view.saves).toHaveLength(0)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(1)
      expect(view.saves).toHaveLength(1)
      expect(view.saves[0]!.agent_backends?.claude).toEqual(normalized())
    } finally {
      view.dispose()
    }
  })

  const edits: Array<{ name: string; change: (container: HTMLElement) => void; expected: Partial<AcpConfig> }> = [
    {
      name: "command",
      change: (container) => typeInto(field(container, "command"), '["/test/other-adapter","--acp"]'),
      expected: { command: ["/test/other-adapter", "--acp"] },
    },
    {
      name: "environment",
      change: (container) => typeInto(field(container, "environment"), '{"TEST_TOKEN":"private-value"}'),
      expected: { env: { TEST_TOKEN: "private-value" } },
    },
    {
      name: "model",
      change: (container) => typeInto(field(container, "model"), " selected-model "),
      expected: { model: "selected-model" },
    },
    { name: "mode", change: (container) => typeInto(field(container, "mode"), " plan "), expected: { mode: "plan" } },
    {
      name: "permission",
      change: (container) => choose(select(container, "permission"), "ask"),
      expected: { permission: "ask" },
    },
  ]
  for (const edit of edits) {
    test(`editing ${edit.name} invalidates ready; save probes the new draft before persisting it`, async () => {
      const next = deferred<AgentBackendProbeResponse>()
      let probes = 0
      const mock = clientMock({ probe: () => (++probes === 1 ? Promise.resolve(ready()) : next.promise) })
      const view = mount({ client: mock.client })
      try {
        await settle()
        await manuallyTest(view.container)
        edit.change(view.container)
        expect(button(view.container, "activate").disabled).toBe(false)
        expect(button(view.container, "messageTest").disabled).toBe(true)
        button(view.container, "activate").click()
        expect(mock.calls).toHaveLength(2)
        expect(mock.calls[1]!.request).toEqual({
          advisor: "claude",
          config: { ...normalized(), ...edit.expected },
          message: false,
        })
        expect(view.saves).toHaveLength(0)
        next.resolve(ready())
        await settle()
        expect(view.saves).toHaveLength(1)
        expect(view.saves[0]!.agent_backends?.claude).toEqual({ ...normalized(), ...edit.expected })
      } finally {
        next.resolve(ready())
        view.dispose()
      }
    })
  }

  test("authentication-required is displayed but never persisted as ready", async () => {
    const mock = clientMock({
      probe: async () => ({
        status: "authentication_required",
        message: "Sign in to the adapter",
        authMethods: [{ id: "browser", name: "Browser", type: "agent", environment: [], description: "Open login" }],
      }),
    })
    const view = mount({ client: mock.client })
    try {
      await settle()
      expect(button(view.container, "activate").disabled).toBe(false)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(1)
      expect(mock.calls[0]!.request.message).toBe(false)
      expect(view.saves).toHaveLength(0)
      expect(view.container.textContent).toContain("agentBackend.authRequired")
      expect(view.container.textContent).toContain("Sign in to the adapter")
      expect(view.container.textContent).toContain("agentBackend.login: Browser")
      expect(button(view.container, "messageTest").disabled).toBe(true)
      expect(button(view.container, "activate").disabled).toBe(false)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(2)
      expect(view.saves).toHaveLength(0)
    } finally {
      view.dispose()
    }
  })

  test("an error probe response is shown, leaves save enabled, and cannot activate the backend", async () => {
    const mock = clientMock({
      probe: async () => ({ status: "error", message: "Adapter handshake failed", authMethods: [] }),
    })
    const view = mount({ client: mock.client })
    try {
      await settle()
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(1)
      expect(view.saves).toHaveLength(0)
      expect(view.container.textContent).toContain("agentBackend.failed")
      expect(view.container.textContent).toContain("Adapter handshake failed")
      expect(button(view.container, "activate").disabled).toBe(false)
      expect(button(view.container, "messageTest").disabled).toBe(true)
    } finally {
      view.dispose()
    }
  })

  test("a rejected probe never saves and a subsequent save can probe and succeed", async () => {
    let count = 0
    const mock = clientMock({
      probe: async () => {
        if (++count === 1) throw new Error("Probe transport unavailable")
        return ready()
      },
    })
    const view = mount({ client: mock.client })
    try {
      await settle()
      button(view.container, "activate").click()
      await settle()
      expect(view.saves).toHaveLength(0)
      expect(alerts(view.container)).toContain("Probe transport unavailable")
      expect(button(view.container, "activate").disabled).toBe(false)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(2)
      expect(view.saves).toHaveLength(1)
    } finally {
      view.dispose()
    }
  })

  for (const invalid of [
    { name: "command", value: "[]", message: "Command must be a nonempty JSON array of strings" },
    { name: "environment", value: '{"TOKEN":42}', message: "Environment must be a JSON object with string values" },
  ]) {
    test(`an invalid ${invalid.name} does not disable idle save, but validates before probe or onSave`, async () => {
      const mock = clientMock()
      const view = mount({ client: mock.client })
      try {
        await settle()
        typeInto(field(view.container, invalid.name), invalid.value)
        expect(button(view.container, "activate").disabled).toBe(false)
        button(view.container, "activate").click()
        await settle()
        expect(mock.calls).toHaveLength(0)
        expect(view.saves).toHaveLength(0)
        expect(alerts(view.container)).toContain(invalid.message)
        expect(button(view.container, "activate").disabled).toBe(false)
      } finally {
        view.dispose()
      }
    })
  }

  const managedStatus = (installed: boolean): AgentBackendStatusResponse => ({
    ...status(),
    adapters: [
      {
        advisor: "claude",
        package: "@test/claude-acp",
        source: "https://example.test/claude-acp",
        loginHelp: "Run the adapter login",
        requires: ["node", "npm"],
        recommended: "1.2.3",
        releases: ["1.2.3"],
        installed: installed ? [{ version: "1.2.3", installedAt: 1, command: ["/test/managed-adapter", "--acp"] }] : [],
      },
    ],
  })

  test("managed first load keeps the adapter card and never flashes a custom command", async () => {
    const pending = deferred<AgentBackendStatusResponse>()
    const mock = clientMock({ status: () => pending.promise })
    const current = configuration(backend({ managed: { advisor: "claude", version: "1.2.3" } }))
    const view = mount({ client: mock.client, config: current })
    try {
      await settle()
      expect(select(view.container, "source").value).toBe("managed")
      const card = view.container.querySelector('section[aria-label="agentSettings.adapter"]')
      expect(card).not.toBeNull()
      expect(view.container.querySelector("textarea")).not.toBeNull()
      expect(view.container.querySelector('input[aria-label="agentBackend.command"]')).toBeNull()
      expect(view.container.textContent).not.toContain("agentBackend.customOnly")
      expect(view.container.querySelectorAll('[data-component="input"] label').length).toBeGreaterThan(0)
      expect(
        [...view.container.querySelectorAll('[data-component="input"] label')].some(
          (e) => e.textContent === "agentBackend.command",
        ),
      ).toBe(false)
      pending.resolve(managedStatus(true))
      await settle()
      expect(view.container.querySelector('section[aria-label="agentSettings.adapter"]')).toBe(card)
      expect(select(view.container, "source").value).toBe("managed")
    } finally {
      pending.resolve(managedStatus(true))
      view.dispose()
    }
  })

  test("local refresh and failure retain card nodes, draft edits and expanded details", async () => {
    const pending = deferred<AgentBackendStatusResponse>()
    let requests = 0
    const mock = clientMock({
      status: () => (++requests === 1 ? Promise.resolve(managedStatus(true)) : pending.promise),
    })
    const view = mount({
      client: mock.client,
      config: configuration(backend({ managed: { advisor: "claude", version: "1.2.3" } })),
    })
    try {
      await settle()
      const model = field(view.container, "model")
      typeInto(model, "unsaved-model")
      const details = model.closest("details")!
      const card = view.container.querySelector('section[aria-label="agentSettings.adapter"]')
      button(view.container, "refresh").click()
      expect(select(view.container, "source").value).toBe("managed")
      expect(view.container.textContent).toContain("local-test-server")
      pending.reject(new Error("Inspection unavailable"))
      await settle()
      expect(view.container.querySelector('section[aria-label="agentSettings.adapter"]')).toBe(card)
      expect(field(view.container, "model")).toBe(model)
      expect(model.value).toBe("unsaved-model")
      expect(details.open).toBe(true)
      expect(alerts(view.container)).toContain("Inspection unavailable")
      expect(view.saves).toHaveLength(0)
    } finally {
      pending.resolve(managedStatus(true))
      view.dispose()
    }
  })

  test("equal configuration clones do not reset edits or inspect again", async () => {
    const mock = clientMock()
    const current = configuration()
    const view = mount({ client: mock.client, config: current })
    try {
      await settle()
      const input = field(view.container, "model")
      typeInto(input, "local-edit")
      view.update({ config: structuredClone(current) })
      await settle()
      expect(field(view.container, "model")).toBe(input)
      expect(input.value).toBe("local-edit")
      expect(mock.inspections).toHaveLength(1)
    } finally {
      view.dispose()
    }
  })

  test("an initial inspection failure stays unknown without a custom-only fallback", async () => {
    const mock = clientMock({
      status: async () => {
        throw new Error("Offline")
      },
    })
    const view = mount({
      client: mock.client,
      config: configuration(backend({ managed: { advisor: "claude", version: "1.2.3" } })),
    })
    try {
      await settle()
      expect(select(view.container, "source").value).toBe("managed")
      expect(view.container.textContent).not.toContain("agentBackend.customOnly")
      expect(alerts(view.container)).toContain("Offline")
      expect(button(view.container, "activate").disabled).toBe(true)
    } finally {
      view.dispose()
    }
  })

  test("an uninstalled managed adapter leaves idle save enabled but cannot probe or save", async () => {
    const mock = clientMock({ status: async () => managedStatus(false) })
    const view = mount({ client: mock.client, config: {} })
    try {
      await settle()
      choose(select(view.container, "transport"), "acp")
      expect(button(view.container, "activate").disabled).toBe(false)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(0)
      expect(view.saves).toHaveLength(0)
      expect(alerts(view.container)).toContain("agentBackend.notInstalled")
      expect(button(view.container, "activate").disabled).toBe(false)
    } finally {
      view.dispose()
    }
  })

  test("managed ACP save probes and persists the selected installed version and command", async () => {
    const mock = clientMock({ status: async () => managedStatus(true) })
    const view = mount({ client: mock.client, config: {} })
    const expected = normalized(
      backend({
        command: ["/test/managed-adapter", "--acp"],
        managed: { advisor: "claude", version: "1.2.3" },
      }),
    )
    try {
      await settle()
      choose(select(view.container, "transport"), "acp")
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(1)
      expect(mock.calls[0]!.request).toEqual({ advisor: "claude", config: expected, message: false })
      expect(view.saves).toHaveLength(1)
      expect(view.saves[0]!.agent_backends?.claude).toEqual(expected)
    } finally {
      view.dispose()
    }
  })

  test("cancelling save aborts its probe and a late ready cannot save or authorize a later save", async () => {
    const pending = deferred<AgentBackendProbeResponse>()
    let count = 0
    const mock = clientMock({ probe: () => (++count === 1 ? pending.promise : Promise.resolve(ready())) })
    const view = mount({ client: mock.client })
    try {
      await settle()
      button(view.container, "activate").click()
      expect(mock.calls).toHaveLength(1)
      button(view.container, "common.cancel").click()
      expect(mock.calls[0]!.options.signal.aborted).toBe(true)
      pending.resolve(ready())
      await settle()
      expect(view.saves).toHaveLength(0)
      expect(button(view.container, "messageTest").disabled).toBe(true)
      expect(view.container.textContent).not.toContain("agentBackend.saved")
      expect(button(view.container, "activate").disabled).toBe(false)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(2)
      expect(view.saves).toHaveLength(1)
    } finally {
      pending.resolve(ready())
      view.dispose()
    }
  })

  test("unmounting during save aborts its probe and a late ready never calls onSave", async () => {
    const pending = deferred<AgentBackendProbeResponse>()
    const mock = clientMock({ probe: () => pending.promise })
    const view = mount({ client: mock.client })
    try {
      await settle()
      button(view.container, "activate").click()
      expect(mock.calls).toHaveLength(1)
      view.dispose()
      expect(mock.calls[0]!.options.signal.aborted).toBe(true)
      pending.resolve(ready())
      await settle()
      expect(view.saves).toHaveLength(0)
      expect(document.body.contains(view.container)).toBe(false)
    } finally {
      pending.resolve(ready())
      view.dispose()
    }
  })

  test("switching advisor drops an old ready and only the new advisor's probe can save", async () => {
    const pending = deferred<AgentBackendProbeResponse>()
    let count = 0
    const mock = clientMock({ probe: () => (++count === 1 ? pending.promise : Promise.resolve(ready())) })
    const other = backend({ command: ["/test/codex-adapter"] })
    const current = configuration()
    current.agent_backends = { ...current.agent_backends, codex: other }
    const view = mount({ client: mock.client, config: current })
    try {
      await settle()
      button(view.container, "activate").click()
      expect(mock.calls).toHaveLength(1)
      view.update({ advisor: "codex" })
      await settle()
      expect(mock.calls[0]!.options.signal.aborted).toBe(true)
      pending.resolve(ready())
      await settle()
      expect(view.saves).toHaveLength(0)
      expect(view.container.querySelector("section")?.getAttribute("data-agent-backend")).toBe("codex")
      expect(button(view.container, "messageTest").disabled).toBe(true)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(2)
      expect(mock.calls[1]!.request).toEqual({ advisor: "codex", config: normalized(other), message: false })
      expect(view.saves).toHaveLength(1)
      expect(view.saves[0]!.agent_backends?.codex).toEqual(normalized(other))
      expect(view.saves[0]!.agent_backends?.claude).toEqual(current.agent_backends?.claude)
    } finally {
      pending.resolve(ready())
      view.dispose()
    }
  })

  test("replacing the active backend config drops old ready and probes the replacement before saving", async () => {
    const pending = deferred<AgentBackendProbeResponse>()
    let count = 0
    const mock = clientMock({ probe: () => (++count === 1 ? pending.promise : Promise.resolve(ready())) })
    const other = backend({ command: ["/test/server-replacement"], model: "server-model" })
    const view = mount({ client: mock.client })
    try {
      await settle()
      button(view.container, "activate").click()
      expect(mock.calls).toHaveLength(1)
      view.update({ config: configuration(other) })
      await settle()
      expect(mock.calls[0]!.options.signal.aborted).toBe(true)
      pending.resolve(ready())
      await settle()
      expect(view.saves).toHaveLength(0)
      expect(field(view.container, "command").value).toBe(JSON.stringify(other.command))
      expect(button(view.container, "messageTest").disabled).toBe(true)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(2)
      expect(mock.calls[1]!.request.config).toEqual(normalized(other))
      expect(view.saves).toHaveLength(1)
      expect(view.saves[0]!.agent_backends?.claude).toEqual(normalized(other))
    } finally {
      pending.resolve(ready())
      view.dispose()
    }
  })

  test("switching client drops old ready even for the same advisor and byte-identical config", async () => {
    const pending = deferred<AgentBackendProbeResponse>()
    const original = clientMock({ probe: () => pending.promise })
    const replacement = clientMock()
    const view = mount({ client: original.client })
    try {
      await settle()
      button(view.container, "activate").click()
      expect(original.calls).toHaveLength(1)
      view.update({ client: replacement.client })
      await settle()
      expect(original.calls[0]!.options.signal.aborted).toBe(true)
      pending.resolve(ready())
      await settle()
      expect(view.saves).toHaveLength(0)
      expect(replacement.calls).toHaveLength(0)
      expect(button(view.container, "messageTest").disabled).toBe(true)
      button(view.container, "activate").click()
      await settle()
      expect(original.calls).toHaveLength(1)
      expect(replacement.calls).toHaveLength(1)
      expect(replacement.calls[0]!.request).toEqual({ advisor: "claude", config: normalized(), message: false })
      expect(view.saves).toHaveLength(1)
    } finally {
      pending.resolve(ready())
      view.dispose()
    }
  })

  test("CLI JSON saves directly without any ACP probe and preserves other advisor settings", async () => {
    const mock = clientMock()
    const current = configuration()
    const view = mount({ client: mock.client, config: current })
    try {
      await settle()
      choose(select(view.container, "transport"), "cli-json")
      expect(button(view.container, "activate").disabled).toBe(false)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(0)
      expect(view.saves).toEqual([
        {
          agent_backends: { ...current.agent_backends, claude: { type: "cli-json" } },
          external_agents: {
            ...current.external_agents,
            claude: { ...current.external_agents?.claude, enabled: true },
          },
        },
      ])
    } finally {
      view.dispose()
    }
  })

  test("Pi Native RPC saves directly, enables Pi, and never probes ACP", async () => {
    const mock = clientMock()
    const current = configuration()
    const view = mount({ client: mock.client, config: current, advisor: "pi" })
    try {
      await settle()
      expect(select(view.container, "transport").value).toBe("native-rpc")
      expect(maybeButton(view.container, "test")).toBeUndefined()
      expect(button(view.container, "activate").disabled).toBe(false)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(0)
      expect(view.saves).toEqual([
        {
          agent_backends: { ...current.agent_backends, pi: { type: "native-rpc" } },
          pi: { ...current.pi, enabled: true },
        },
      ])
      expect(view.saves[0]).not.toHaveProperty("external_agents")
    } finally {
      view.dispose()
    }
  })

  test("a model message requires a separate explicit confirmation even after an automatic save probe", async () => {
    const mock = clientMock({
      probe: async (request) => ({
        ...ready(),
        ...(request.message ? { response: "Confirmed model response" } : {}),
      }),
    })
    const view = mount({ client: mock.client })
    try {
      await settle()
      expect(button(view.container, "messageTest").disabled).toBe(true)
      expect(maybeButton(view.container, "confirmMessage")).toBeUndefined()
      button(view.container, "activate").click()
      await settle()
      expect(view.saves).toHaveLength(1)
      expect(mock.calls).toHaveLength(1)
      expect(mock.calls[0]!.request.message).toBe(false)
      expect(maybeButton(view.container, "confirmMessage")).toBeUndefined()
      expect(view.container.textContent).not.toContain("agentBackend.messageConsent")
      button(view.container, "messageTest").click()
      await settle()
      expect(mock.calls).toHaveLength(1)
      expect(view.container.textContent).toContain("agentBackend.messageConsent")
      expect(button(view.container, "confirmMessage").disabled).toBe(false)
      button(view.container, "confirmMessage").click()
      await settle()
      expect(mock.calls).toHaveLength(2)
      expect(mock.calls[1]!.request).toEqual({
        advisor: "claude",
        config: normalized(),
        message: true,
        authMethod: undefined,
      })
      expect(view.container.textContent).toContain("Confirmed model response")
      expect(maybeButton(view.container, "confirmMessage")).toBeUndefined()
      expect(view.saves).toHaveLength(1)
      // A successful message probe does not itself save, and saving its same
      // ready draft neither sends another message nor repeats initialization.
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(2)
      expect(view.saves).toHaveLength(2)
    } finally {
      view.dispose()
    }
  })

  test("editing a draft revokes model-message consent and saving never reuses that consent", async () => {
    const mock = clientMock()
    const view = mount({ client: mock.client })
    try {
      await settle()
      await manuallyTest(view.container)
      button(view.container, "messageTest").click()
      expect(maybeButton(view.container, "confirmMessage")).toBeDefined()
      typeInto(field(view.container, "model"), "replacement-model")
      expect(maybeButton(view.container, "confirmMessage")).toBeUndefined()
      expect(button(view.container, "messageTest").disabled).toBe(true)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(2)
      expect(mock.calls.every((call) => call.request.message === false)).toBe(true)
      expect(view.saves).toHaveLength(1)
      expect(maybeButton(view.container, "confirmMessage")).toBeUndefined()
    } finally {
      view.dispose()
    }
  })

  test("a cancelled manual probe cannot leave a ready cache that skips the next save probe", async () => {
    const pending = deferred<AgentBackendProbeResponse>()
    let count = 0
    const mock = clientMock({ probe: () => (++count === 1 ? pending.promise : Promise.resolve(ready())) })
    const view = mount({ client: mock.client })
    try {
      await settle()
      button(view.container, "test").click()
      expect(mock.calls).toHaveLength(1)
      button(view.container, "common.cancel").click()
      pending.resolve(ready())
      await settle()
      expect(mock.calls[0]!.options.signal.aborted).toBe(true)
      expect(button(view.container, "messageTest").disabled).toBe(true)
      expect(view.saves).toHaveLength(0)
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(2)
      expect(view.saves).toHaveLength(1)
    } finally {
      pending.resolve(ready())
      view.dispose()
    }
  })

  test("onSave failure keeps the ready draft retryable without another probe and emits string logs", async () => {
    const logs: unknown[][] = []
    const originals = { info: console.info, warn: console.warn, debug: console.debug }
    console.info = (...values: unknown[]) => {
      logs.push(values)
    }
    console.warn = (...values: unknown[]) => {
      logs.push(values)
    }
    console.debug = (...values: unknown[]) => {
      logs.push(values)
    }
    const mock = clientMock()
    const view = mount({
      client: mock.client,
      onSave: async () => {
        throw new Error("Settings write failed")
      },
    })
    try {
      await settle()
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(1)
      expect(view.saves).toHaveLength(1)
      expect(alerts(view.container)).toContain("Settings write failed")
      expect(button(view.container, "activate").disabled).toBe(false)
      expect(field(view.container, "command").value).toBe(JSON.stringify(backend().command))
      expect(view.container.textContent).not.toContain("agentBackend.saved")
      button(view.container, "activate").click()
      await settle()
      expect(mock.calls).toHaveLength(1)
      expect(view.saves).toHaveLength(2)
      expect(logs.length).toBeGreaterThan(0)
      expect(logs.every((values) => values.length === 1 && typeof values[0] === "string")).toBe(true)
    } finally {
      view.dispose()
      console.info = originals.info
      console.warn = originals.warn
      console.debug = originals.debug
    }
  })
})
