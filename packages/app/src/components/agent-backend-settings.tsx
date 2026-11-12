import { createEffect, createMemo, createUniqueId, For, on, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import type {
  Config,
  OpencodeClient,
  AgentBackendPrepareResponse,
  AgentBackendProbeResponse,
} from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { mainDomain } from "@/pages/layout/extra-agents"
import { parseAcpCommand, parseAcpEnvironment } from "./agent-backend-config"
import { createAgentBackendStatus } from "./agent-backend-status"
import { AgentSettingsCard, AgentSettingsDetails, AgentSettingsField, AgentSettingsGrid } from "./agent-settings-layout"
import { Link } from "./link"

export type AdvisorID = "claude" | "codex" | "pi" | "grok" | "dsh"
type AcpConfig = Extract<NonNullable<NonNullable<Config["agent_backends"]>["claude"]>, { type: "acp" }>

function backendSignature(backend: NonNullable<Config["agent_backends"]>[AdvisorID], advisor: AdvisorID) {
  if (backend?.type !== "acp")
    return JSON.stringify({ type: backend?.type ?? (advisor === "pi" ? "native-rpc" : "cli-json") })
  return JSON.stringify({
    type: backend.type,
    command: backend.command,
    managed: backend.managed,
    env: Object.fromEntries(Object.entries(backend.env ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    model: backend.model?.trim() || undefined,
    mode: backend.mode?.trim() || undefined,
    permission: backend.permission ?? "deny",
  })
}

export function AgentBackendSettings(props: {
  advisor: AdvisorID
  config: Config
  client: OpencodeClient
  remote?: boolean
  onSave: (patch: Partial<Config>) => Promise<unknown>
  cliSettings?: () => JSX.Element
  cliInstalled?: boolean
  sourceUrl?: string
}) {
  const { t } = useLanguage()
  const versionID = createUniqueId()
  const [state, setState] = createStore({
    type: (props.config.agent_backends?.[props.advisor]?.type ??
      (props.advisor === "pi" ? "native-rpc" : "cli-json")) as string,
    source: "managed",
    version: "",
    command: "[]",
    env: "{}",
    model: "",
    mode: "",
    permission: "deny",
    confirmation: undefined as AgentBackendPrepareResponse | undefined,
    result: undefined as AgentBackendProbeResponse | undefined,
    tested: "",
    busy: "",
    error: "",
    saved: false,
    messageConsent: false,
  })
  let controller: AbortController | undefined
  let generation = 0
  onCleanup(() => {
    generation++
    controller?.abort()
  })
  const status = createAgentBackendStatus(() => props.client)
  const recipe = createMemo(() => status.latest?.adapters.find((item) => item.advisor === props.advisor))
  const installed = createMemo(() => recipe()?.installed.find((item) => item.version === state.version))
  const active = () => props.config.agent_backends?.[props.advisor]
  const cliType = () => (props.advisor === "pi" ? "native-rpc" : "cli-json")
  const acpInstalled = createMemo(() => (recipe()?.installed.length ?? 0) > 0 || active()?.type === "acp")
  const tabs = createMemo(() => [
    { value: cliType(), label: props.advisor === "pi" ? "Native RPC" : "CLI", installed: props.cliInstalled === true },
    { value: "acp", label: "ACP", installed: acpInstalled() },
  ])
  let tablistRef: HTMLDivElement | undefined
  const onTablistKeyDown = (event: KeyboardEvent) => {
    if (state.busy) return
    const values = tabs().map((tab) => tab.value)
    const index = values.indexOf(state.type)
    let next = index
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % values.length
        break
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + values.length) % values.length
        break
      case "Home":
        next = 0
        break
      case "End":
        next = values.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    change("type", values[next])
    tablistRef?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }
  const managedMode = () =>
    state.source === "managed" &&
    (!!recipe() || !status.latest || (active()?.type === "acp" && !!(active() as AcpConfig).managed))
  const customMode = () => state.source === "custom" || (!!status.latest && !recipe() && !managedMode())
  const invalidate = () => {
    setState({ tested: "", result: undefined, saved: false, confirmation: undefined, messageConsent: false })
  }
  const change = (
    key: "type" | "source" | "version" | "command" | "env" | "model" | "mode" | "permission",
    value: string,
  ) => {
    setState(key, value)
    invalidate()
  }
  const draft = (): AcpConfig => {
    if (managedMode() && !recipe()) throw new Error(status.latest ? t("agentBackend.customOnly") : t("common.loading"))
    const managed = managedMode() ? installed() : undefined
    if (managedMode() && !managed) throw new Error(t("agentBackend.notInstalled"))
    return {
      type: "acp",
      command: managed?.command ?? parseAcpCommand(state.command),
      ...(managed
        ? { managed: { advisor: props.advisor as "claude" | "codex" | "pi", version: managed.version } }
        : {}),
      env: parseAcpEnvironment(state.env),
      model: state.model.trim() || undefined,
      mode: state.mode.trim() || undefined,
      permission: state.permission === "ask" ? "ask" : "deny",
    }
  }
  const tested = () => {
    try {
      return state.tested === JSON.stringify(draft()) && state.result?.status === "ready"
    } catch {
      return false
    }
  }
  createEffect(() => {
    const recommended = recipe()?.recommended
    if (!state.version && recommended) setState("version", recommended)
  })
  const backendKey = createMemo(() => backendSignature(props.config.agent_backends?.[props.advisor], props.advisor))
  let submitted: { advisor: AdvisorID; client: OpencodeClient; signature: string } | undefined
  const perform = async (name: string, fn: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (state.busy) return
    const run = ++generation
    const operation = new AbortController()
    const advisor = props.advisor
    const current = () => run === generation && !operation.signal.aborted
    controller = operation
    setState({ busy: name, error: "", saved: false })
    console.info(`[agent-backend.settings] start advisor=${advisor} action=${name} run=${run}`)
    try {
      await fn(operation.signal, current)
      if (run === generation && operation.signal.aborted) setState("error", t("agentBackend.cancelled"))
      console.info(
        `[agent-backend.settings] finished advisor=${advisor} action=${name} run=${run} current=${current()}`,
      )
    } catch (error) {
      if (run === generation) setState("error", operation.signal.aborted ? t("agentBackend.cancelled") : String(error))
      console.warn(
        `[agent-backend.settings] failed advisor=${advisor} action=${name} run=${run} cancelled=${operation.signal.aborted}`,
      )
    } finally {
      if (run === generation) setState("busy", "")
    }
  }
  let initialized: { advisor: AdvisorID; client: OpencodeClient; signature: string } | undefined
  createEffect(
    on(
      () => [props.advisor, backendKey(), props.client] as const,
      ([advisor, signature, client]) => {
        if (initialized?.advisor === advisor && initialized.client === client && initialized.signature === signature)
          return
        initialized = { advisor, client, signature }
        if (submitted?.advisor === advisor && submitted.client === client && submitted.signature === signature) {
          submitted = undefined
          console.info(`[agent-backend.settings] saved baseline accepted advisor=${advisor}`)
          return
        }
        submitted = undefined
        const backend = props.config.agent_backends?.[advisor]
        generation++
        controller?.abort()
        setState({
          type: backend?.type ?? (advisor === "pi" ? "native-rpc" : "cli-json"),
          source: backend?.type === "acp" && !backend.managed ? "custom" : "managed",
          version: backend?.type === "acp" ? (backend.managed?.version ?? "") : "",
          command: backend?.type === "acp" ? JSON.stringify(backend.command) : "[]",
          env: backend?.type === "acp" ? JSON.stringify(backend.env ?? {}) : "{}",
          model: backend?.type === "acp" ? (backend.model ?? "") : "",
          mode: backend?.type === "acp" ? (backend.mode ?? "") : "",
          permission: backend?.type === "acp" ? (backend.permission ?? "deny") : "deny",
          busy: "",
          error: "",
          confirmation: undefined,
          result: undefined,
          tested: "",
          saved: false,
          messageConsent: false,
        })
        console.info(`[agent-backend.settings] draft initialized advisor=${advisor}`)
      },
    ),
  )
  const prepare = (action: "install" | "remove") =>
    perform("prepare", async (signal, current) => {
      const adapter = recipe()
      if (!adapter) throw new Error(t("agentBackend.customOnly"))
      const result = await props.client.agentBackend.prepare(
        { advisor: adapter.advisor, version: state.version, action },
        { signal, throwOnError: true },
      )
      if (current()) setState("confirmation", result.data)
    })
  const testConnection = async (
    config: AcpConfig,
    signal: AbortSignal,
    current: () => boolean,
    message = false,
    authMethod?: string,
  ) => {
    const advisor = props.advisor
    setState("messageConsent", false)
    console.info(`[agent-backend.settings] probe advisor=${advisor} message=${message} login=${!!authMethod}`)
    const result = await props.client.agentBackend.probe(
      { advisor, config, message, authMethod },
      { signal, throwOnError: true },
    )
    if (!current()) {
      console.info(`[agent-backend.settings] probe discarded advisor=${advisor}`)
      return false
    }
    setState({ result: result.data, tested: result.data.status === "ready" ? JSON.stringify(config) : "" })
    console.info(`[agent-backend.settings] probe result advisor=${advisor} status=${result.data.status}`)
    return result.data.status === "ready"
  }
  const probe = (message = false, authMethod?: string) =>
    perform(authMethod ? "login" : "probe", async (signal, current) => {
      await testConnection(draft(), signal, current, message, authMethod)
    })
  const save = () =>
    perform("save", async (signal, current) => {
      const advisor = props.advisor
      const backend =
        state.type === "acp" ? draft() : { type: advisor === "pi" ? ("native-rpc" as const) : ("cli-json" as const) }
      if (backend.type === "acp") {
        const verified = tested()
        console.info(`[agent-backend.settings] save validation advisor=${advisor} cached=${verified}`)
        if (!verified && !(await testConnection(backend, signal, current))) {
          console.info(`[agent-backend.settings] save blocked advisor=${advisor}`)
          return
        }
      }
      if (!current()) return
      console.info(`[agent-backend.settings] save submit advisor=${advisor} type=${backend.type}`)
      submitted = { advisor, client: props.client, signature: backendSignature(backend, advisor) }
      await props.onSave({
        agent_backends: { ...props.config.agent_backends, [advisor]: backend },
        ...(advisor === "pi"
          ? { pi: { ...props.config.pi, enabled: true } }
          : {
              external_agents: {
                ...props.config.external_agents,
                [advisor]: { ...props.config.external_agents?.[advisor], enabled: true },
              },
            }),
      })
      console.info(`[agent-backend.settings] save completed advisor=${advisor} current=${current()}`)
      if (current()) setState("saved", true)
    })
  const sourceOptions = createMemo(() => [
    ...(recipe() || managedMode() ? [{ value: "managed", label: t("agentBackend.managed") }] : []),
    { value: "custom", label: t("agentBackend.custom") },
  ])
  const permissionOptions = createMemo(() => [
    { value: "deny", label: t("agentBackend.deny") },
    { value: "ask", label: t("agentBackend.ask") },
  ])
  const versionOptions = createMemo(() => {
    if (!recipe()) return [{ value: state.version, label: state.version || t("common.loading") }]
    return (recipe()?.releases ?? []).map((version) => ({
      value: version,
      label:
        version +
        (version === recipe()?.recommended ? ` (${t("agentBackend.recommended")})` : "") +
        (recipe()?.installed.some((item) => item.version === version) ? ` · ${t("agentBackend.installed")}` : ""),
    }))
  })
  return (
    <section data-agent-backend={props.advisor} class="flex min-w-0 flex-col gap-3">
      <div
        ref={tablistRef}
        role="tablist"
        aria-label={t("agentBackend.transport")}
        class="relative grid w-full max-w-[300px] grid-cols-2 rounded-full border border-border-weak-base bg-surface-secondary/70 p-1"
        onKeyDown={onTablistKeyDown}
      >
        <span
          aria-hidden="true"
          class="absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-full bg-text-strong shadow-sm transition-transform duration-200 ease-out"
          style={{ transform: state.type === "acp" ? "translateX(100%)" : "translateX(0%)" }}
        />
        <For each={tabs()}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              id={`${versionID}-tab-${tab.value}`}
              aria-selected={state.type === tab.value}
              aria-controls={`${versionID}-panel`}
              tabIndex={state.type === tab.value ? 0 : -1}
              disabled={!!state.busy}
              onClick={() => change("type", tab.value)}
              class="relative z-10 flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-13-medium transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-60"
              classList={{
                "text-surface-base": state.type === tab.value,
                "text-text-weak hover:text-text-base": state.type !== tab.value,
              }}
            >
              {tab.label}
              <Show when={tab.installed}>
                <Icon name="check-small" size="small" aria-label={t("agentBackend.installed")} />
              </Show>
            </button>
          )}
        </For>
      </div>
      <div
        role="tabpanel"
        id={`${versionID}-panel`}
        aria-labelledby={`${versionID}-tab-${state.type}`}
        class="flex min-w-0 flex-col gap-3"
      >
        <AgentSettingsGrid>
          <Show when={state.type !== "acp" && props.sourceUrl}>
            {(url) => (
              <AgentSettingsCard title={t("agentSettings.cliSource")} size="compact">
                <Link
                  href={url()}
                  title={url()}
                  style={{ "text-decoration": "none" }}
                  class="group flex min-h-7 min-w-0 items-center gap-2 text-text-base transition-colors hover:text-text-strong"
                >
                  <Icon
                    name="github"
                    size="small"
                    class="shrink-0 text-text-weak transition-colors group-hover:text-text-strong"
                  />
                  <span class="truncate font-mono text-12-regular">{url().replace(/^https?:\/\//, "")}</span>
                  <Icon
                    name="arrow-right"
                    size="small"
                    class="shrink-0 text-text-weak transition-colors group-hover:text-text-strong"
                  />
                </Link>
              </AgentSettingsCard>
            )}
          </Show>
          <AgentSettingsCard title={t("agentSettings.connection")} badge={t("agentSettings.important")} size="compact">
            <div
              class="flex min-h-7 min-w-0 flex-wrap items-center justify-between gap-2 text-12-regular text-text-weak"
              data-agent-backend-target
            >
              <span class="min-w-0 break-words">
                {t("agentBackend.target")}: {status.latest?.target ?? "..."}
              </span>
              <Button
                size="small"
                variant="ghost"
                disabled={!!state.busy || status.loading}
                onClick={() => void status.refresh()}
              >
                {t("agentBackend.refresh")}
              </Button>
            </div>
            <Show when={props.remote}>
              <p class="text-12-regular text-text-base">{t("agentBackend.remote")}</p>
            </Show>
            <Show when={state.type === "acp"}>
              <label class="flex min-w-0 max-w-full flex-col items-start gap-2 text-12-medium text-text-strong">
                {t("agentBackend.source")}
                <Select
                  triggerProps={{ "aria-label": t("agentBackend.source") }}
                  options={sourceOptions()}
                  current={sourceOptions().find((o) => o.value === (customMode() ? "custom" : state.source))}
                  value={(o) => o.value}
                  label={(o) => o.label}
                  onSelect={(o) => o && change("source", o.value)}
                  disabled={!!state.busy}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
              </label>
            </Show>
          </AgentSettingsCard>
          <Show when={state.type === "acp"}>
            <Show when={managedMode()}>
              <AgentSettingsCard title={t("agentSettings.adapter")} size="compact">
                <label for={versionID} class="block text-12-medium text-text-base">
                  {t("agentBackend.version")}
                </label>
                <div class="flex min-w-0 flex-wrap items-center gap-3">
                  <Select
                    triggerProps={{ "aria-label": t("agentBackend.version"), id: versionID }}
                    options={versionOptions()}
                    current={versionOptions().find((o) => o.value === state.version)}
                    value={(o) => o.value}
                    label={(o) => o.label}
                    onSelect={(o) => o && change("version", o.value)}
                    disabled={!!state.busy || !recipe()}
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                    triggerStyle={{ height: "2.25rem" }}
                  />
                  <div class="flex flex-wrap items-center gap-2">
                    <Show
                      when={
                        recipe()?.installed.length &&
                        !recipe()?.installed.some((item) => item.version === recipe()?.recommended)
                      }
                    >
                      <Button
                        size="small"
                        style={{ height: "2.25rem" }}
                        variant="secondary"
                        disabled={!!state.busy}
                        onClick={() => {
                          change("version", recipe()!.recommended)
                          void prepare("install")
                        }}
                      >
                        {t("agentBackend.update")}
                      </Button>
                    </Show>
                    <Button
                      size="small"
                      style={{ height: "2.25rem" }}
                      variant="secondary"
                      disabled={!!state.busy || !recipe() || !!installed()}
                      onClick={() => void prepare("install")}
                    >
                      {t("agentBackend.install")}
                    </Button>
                    <Button
                      size="small"
                      style={{ height: "2.25rem" }}
                      variant="ghost"
                      disabled={
                        !!state.busy ||
                        !installed() ||
                        (active()?.type === "acp" && (active() as AcpConfig).managed?.version === state.version)
                      }
                      onClick={() => void prepare("remove")}
                    >
                      {t("agentBackend.remove")}
                    </Button>
                  </div>
                </div>
                <Show when={status.latest && (!status.latest.node || !status.latest.npm)}>
                  <p class="text-12-regular text-text-danger-base" role="alert">
                    {t("agentBackend.dependencies")}: {!status.latest?.node ? "Node.js " : ""}
                    {!status.latest?.npm ? "npm " : ""}· {t("agentBackend.missing")}
                  </p>
                </Show>
              </AgentSettingsCard>
            </Show>
            <Show when={customMode()}>
              <AgentSettingsCard title={t("agentBackend.command")} badge={t("agentSettings.required")} size="wide">
                <Show when={status.latest && !recipe()}>
                  <p class="text-12-regular text-text-weak">{t("agentBackend.customOnly")}</p>
                </Show>
                <TextField
                  multiline
                  label={t("agentBackend.command")}
                  value={state.command}
                  disabled={!!state.busy}
                  onChange={(value) => change("command", value)}
                  placeholder={'["/path/to/adapter", "--acp"]'}
                />
              </AgentSettingsCard>
            </Show>
          </Show>
        </AgentSettingsGrid>
        <Show when={state.type === "acp"}>
          <AgentSettingsCard size="wide">
            <AgentSettingsDetails title={t("agentBackend.advanced")}>
              <AgentSettingsGrid>
                <AgentSettingsField wide>
                  <TextField
                    label={t("agentBackend.model")}
                    value={state.model}
                    disabled={!!state.busy}
                    onChange={(value) => change("model", value)}
                  />
                </AgentSettingsField>
                <AgentSettingsField wide>
                  <TextField
                    label={t("agentBackend.mode")}
                    value={state.mode}
                    disabled={!!state.busy}
                    onChange={(value) => change("mode", value)}
                  />
                </AgentSettingsField>
                <label class="flex min-w-0 max-w-full flex-col items-start gap-2 text-12-medium text-text-base">
                  {t("agentBackend.permission")}
                  <Select
                    triggerProps={{ "aria-label": t("agentBackend.permission") }}
                    options={permissionOptions()}
                    current={permissionOptions().find((o) => o.value === state.permission)}
                    value={(o) => o.value}
                    label={(o) => o.label}
                    onSelect={(o) => o && change("permission", o.value)}
                    disabled={!!state.busy}
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                  />
                </label>
              </AgentSettingsGrid>
              <TextField
                multiline
                label={t("agentBackend.environment")}
                value={state.env}
                disabled={!!state.busy}
                onChange={(value) => change("env", value)}
              />
              <p class="text-12-regular text-text-weak">{t("agentBackend.safety")}</p>
            </AgentSettingsDetails>
            <AgentSettingsDetails title={t("agentSettings.runtimeDetails")}>
              <div class="text-12-regular break-all">
                {status.latest?.platform}/{status.latest?.arch}
                <br />
                {status.latest?.directory}
              </div>
              <Show when={recipe() && state.source === "managed"}>
                <div class="text-12-regular break-all">
                  {recipe()?.package}
                  <br />
                  <a
                    href={recipe()?.source}
                    target="_blank"
                    rel="noreferrer"
                    class="text-text-interactive-base underline"
                  >
                    {t("agentSettings.source")}
                  </a>
                </div>
                <div class="text-12-regular break-all">
                  {t("agentBackend.dependencies")}: {recipe()?.requires.join(", ")}
                  <br />
                  Node: {status.latest?.node || t("agentBackend.missing")}
                  <br />
                  npm: {status.latest?.npm || t("agentBackend.missing")}
                </div>
                <Show when={installed()}>
                  <code class="text-11-regular break-all">{JSON.stringify(installed()?.command)}</code>
                </Show>
              </Show>
            </AgentSettingsDetails>
          </AgentSettingsCard>
          <Show when={state.messageConsent}>
            <p class="text-12-regular">{t("agentBackend.messageConsent")}</p>
            <Button size="small" variant="secondary" disabled={!!state.busy} onClick={() => void probe(true)}>
              {t("agentBackend.confirmMessage")}
            </Button>
          </Show>
          <Show when={state.result}>
            <div
              role="status"
              class="rounded-lg border border-border-weak-base p-3 text-12-regular whitespace-pre-wrap break-words"
            >
              <strong>
                {state.result?.status === "ready"
                  ? t("agentBackend.ready")
                  : state.result?.status === "authentication_required"
                    ? t("agentBackend.authRequired")
                    : t("agentBackend.failed")}
              </strong>
              <p>{state.result?.message}</p>
              <Show when={state.result?.response}>
                <pre class="whitespace-pre-wrap">{state.result?.response}</pre>
              </Show>
              <Show when={state.result?.status === "authentication_required"}>
                <p class="mt-2">{recipe()?.loginHelp ?? t("agentBackend.loginHelp")}</p>
                <For each={state.result?.authMethods}>
                  {(method) => (
                    <div class="mt-2">
                      <Show when={method.description}>
                        <p>{method.description}</p>
                      </Show>
                      <Show when={method.environment?.length}>
                        <p>
                          {t("agentBackend.environmentNames")}: {method.environment.join(", ")}
                        </p>
                      </Show>
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={!!state.busy || !!props.remote || method.type !== "agent"}
                        onClick={() => void probe(false, method.id)}
                      >
                        {t("agentBackend.login")}: {method.name}
                      </Button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={state.confirmation}>
          {(confirmation) => (
            <div
              role="alertdialog"
              aria-label={t("agentBackend.confirmation")}
              class="rounded-lg border border-border-strong-base p-4 text-12-regular break-all flex flex-col gap-2"
            >
              <strong>
                {t("agentBackend.confirmation")}: {confirmation().action} {confirmation().package}@
                {confirmation().version}
              </strong>
              <p>
                {t("agentBackend.target")}: {confirmation().target}
              </p>
              <p>{confirmation().directory}</p>
              <p>{confirmation().source}</p>
              <code>{confirmation().integrity}</code>
              <p>{t("agentBackend.installNotice")}</p>
              <div class="flex gap-2">
                <Button
                  size="small"
                  variant="primary"
                  disabled={!!state.busy}
                  onClick={() =>
                    void perform("commit", async (signal, current) => {
                      const token = confirmation().token
                      setState("confirmation", undefined)
                      const result = await props.client.agentBackend.commit({ token }, { signal, throwOnError: true })
                      if (!current()) return
                      status.replace(result.data)
                      setState({ confirmation: undefined, tested: "", result: undefined })
                    })
                  }
                >
                  {t("agentBackend.confirm")}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={!!state.busy}
                  onClick={() => setState("confirmation", undefined)}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          )}
        </Show>
        <Show when={status.error}>
          <p role="alert" class="text-12-regular text-text-danger-base">
            {status.error}
          </p>
        </Show>
        <Show when={state.error}>
          <p role="alert" class="text-12-regular text-text-danger-base whitespace-pre-wrap break-words">
            {state.error}
          </p>
        </Show>
        <Show when={state.saved}>
          <p role="status" class="text-12-regular">
            {t("agentBackend.saved")}
          </p>
        </Show>
        <div class="flex w-full flex-wrap items-center justify-end gap-2 border-t border-border-weak-base pt-3">
          <Show when={state.type === "acp"}>
            <Button
              size="small"
              variant="ghost"
              icon="reset"
              disabled={!!state.busy || !status.latest || (managedMode() && !installed())}
              onClick={() => void probe()}
            >
              {t("agentBackend.test")}
            </Button>
            <Button
              size="small"
              variant="ghost"
              disabled={!!state.busy || !tested()}
              onClick={() => setState("messageConsent", true)}
            >
              {t("agentBackend.messageTest")}
            </Button>
          </Show>
          <Show when={state.busy}>
            <span role="status" class="text-12-regular text-text-weak">
              {t("agentBackend.working")}: {state.busy}
            </span>
            <Button size="small" variant="ghost" onClick={() => controller?.abort()}>
              {t("common.cancel")}
            </Button>
          </Show>
          <Button
            size="small"
            variant="secondary"
            icon="save"
            disabled={!!state.busy || !status.latest}
            onClick={() => void save()}
            class="config-save-button"
            data-config-save-state={!!state.busy || !status.latest ? "disabled" : "active"}
          >
            {t("agentBackend.activate")}
          </Button>
        </div>
        <Show when={state.type !== "acp"}>{props.cliSettings?.()}</Show>
        <Show when={state.type === "acp"}>
          <p class="text-11-regular text-text-weak">{t("agentSettings.saveHint")}</p>
        </Show>
      </div>
    </section>
  )
}

export function RemoteAgentBackendSettings() {
  const { t } = useLanguage()
  const sdk = useGlobalSDK()
  const server = useServer()
  const advisorOptions = (["claude", "codex", "pi", "grok", "dsh"] as AdvisorID[]).map((id) => ({
    value: id,
    label: id,
  }))
  const [state, setState] = createStore({
    advisor: "claude" as AdvisorID,
    config: {} as Config,
    error: "",
    loaded: false,
  })
  const client = () => sdk.forDomain(mainDomain).client
  createEffect(() => {
    const current = client()
    const abort = new AbortController()
    setState({ loaded: false, error: "" })
    onCleanup(() => abort.abort())
    void current.global.config
      .get({ throwOnError: true, signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setState({ config: result.data, loaded: true })
      })
      .catch((error) => {
        if (!abort.signal.aborted) setState("error", String(error))
      })
  })
  return (
    <div class="max-w-3xl mx-auto p-6 flex flex-col gap-4">
      <h1 class="text-20-medium">{t("agentBackend.title")}</h1>
      <p>{server.current?.displayName}</p>
      <Select
        triggerProps={{ "aria-label": t("agentBackend.advisor") }}
        options={advisorOptions}
        current={advisorOptions.find((o) => o.value === state.advisor)}
        value={(o) => o.value}
        label={(o) => o.label}
        onSelect={(o) => o && setState("advisor", o.value as AdvisorID)}
        variant="secondary"
        size="small"
        triggerVariant="settings"
      />
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
      <Show when={state.loaded}>
        <AgentBackendSettings
          advisor={state.advisor}
          config={state.config}
          client={client()}
          remote
          onSave={async (patch) => {
            const result = await client().global.config.update({ config: patch }, { throwOnError: true })
            setState("config", result.data)
          }}
        />
      </Show>
    </div>
  )
}
