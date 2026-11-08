import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import type {
  Config,
  OpencodeClient,
  AgentBackendStatusResponse,
  AgentBackendPrepareResponse,
  AgentBackendProbeResponse,
} from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { mainDomain } from "@/pages/layout/extra-agents"
import { parseAcpCommand, parseAcpEnvironment } from "./agent-backend-config"

export type AdvisorID = "claude" | "codex" | "pi" | "grok" | "dsh"
type AcpConfig = Extract<NonNullable<NonNullable<Config["agent_backends"]>["claude"]>, { type: "acp" }>

export function AgentBackendSettings(props: {
  advisor: AdvisorID
  config: Config
  client: OpencodeClient
  remote?: boolean
  onSave: (patch: Partial<Config>) => Promise<unknown>
}) {
  const { t } = useLanguage()
  const [state, setState] = createStore({
    type: "cli-json",
    source: "managed",
    version: "",
    command: "[]",
    env: "{}",
    model: "",
    mode: "",
    permission: "deny",
    status: undefined as AgentBackendStatusResponse | undefined,
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
  const recipe = createMemo(() => state.status?.adapters.find((item) => item.advisor === props.advisor))
  const installed = createMemo(() => recipe()?.installed.find((item) => item.version === state.version))
  const active = () => props.config.agent_backends?.[props.advisor]
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
    const managed = state.source === "managed" && recipe() ? installed() : undefined
    if (state.source === "managed" && recipe() && !managed) throw new Error(t("agentBackend.notInstalled"))
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
  const refresh = async (signal?: AbortSignal) => {
    const result = await props.client.agentBackend.status(undefined, { signal, throwOnError: true })
    if (signal?.aborted) return
    setState("status", result.data)
    if (!state.version)
      setState("version", result.data.adapters.find((item) => item.advisor === props.advisor)?.recommended ?? "")
  }
  const perform = async (name: string, fn: (signal: AbortSignal) => Promise<void>) => {
    if (state.busy) return
    const run = ++generation
    controller = new AbortController()
    setState({ busy: name, error: "", saved: false })
    console.info(`[agent-backend.settings] start advisor=${props.advisor} action=${name}`)
    try {
      await fn(controller.signal)
    } catch (error) {
      if (run === generation) setState("error", controller.signal.aborted ? t("agentBackend.cancelled") : String(error))
      console.warn(`[agent-backend.settings] failed advisor=${props.advisor} action=${name}`)
    } finally {
      if (run === generation) setState("busy", "")
    }
  }
  createEffect(
    on(
      () => [props.advisor, props.config.agent_backends?.[props.advisor], props.client] as const,
      ([advisor, backend]) => {
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
          status: undefined,
          error: "",
          confirmation: undefined,
          result: undefined,
          tested: "",
          saved: false,
          messageConsent: false,
        })
        void perform("inspect", (signal) => refresh(signal))
      },
    ),
  )
  const prepare = (action: "install" | "remove") =>
    perform("prepare", async (signal) => {
      const adapter = recipe()
      if (!adapter) throw new Error(t("agentBackend.customOnly"))
      const result = await props.client.agentBackend.prepare(
        { advisor: adapter.advisor, version: state.version, action },
        { signal, throwOnError: true },
      )
      setState("confirmation", result.data)
    })
  const probe = (message = false, authMethod?: string) =>
    perform(authMethod ? "login" : "probe", async (signal) => {
      setState("messageConsent", false)
      const config = draft()
      const result = await props.client.agentBackend.probe(
        { advisor: props.advisor, config, message, authMethod },
        { signal, throwOnError: true },
      )
      setState({ result: result.data, tested: result.data.status === "ready" ? JSON.stringify(config) : "" })
    })
  const save = () =>
    perform("save", async () => {
      const backend =
        state.type === "acp"
          ? draft()
          : { type: props.advisor === "pi" ? ("native-rpc" as const) : ("cli-json" as const) }
      if (backend.type === "acp" && !tested()) throw new Error(t("agentBackend.testFirst"))
      await props.onSave({
        agent_backends: { ...props.config.agent_backends, [props.advisor]: backend },
        ...(props.advisor === "pi"
          ? { pi: { ...props.config.pi, enabled: true } }
          : {
              external_agents: {
                ...props.config.external_agents,
                [props.advisor]: { ...props.config.external_agents?.[props.advisor], enabled: true },
              },
            }),
      })
      setState("saved", true)
    })
  const selectClass =
    "w-full rounded-lg border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong"
  return (
    <section
      data-agent-backend={props.advisor}
      class="rounded-2xl border border-border-weak-base bg-surface-base p-4 flex flex-col gap-4"
    >
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="text-14-medium text-text-strong">{t("agentBackend.title")}</h3>
          <p class="mt-1 text-12-regular text-text-weak">{t("agentBackend.description")}</p>
        </div>
        <Button
          size="small"
          variant="ghost"
          disabled={!!state.busy}
          onClick={() => void perform("inspect", (signal) => refresh(signal))}
        >
          {t("agentBackend.refresh")}
        </Button>
      </div>
      <div class="rounded-lg bg-surface-raised-base p-3 text-12-regular break-all" data-agent-backend-target>
        <strong>{t("agentBackend.target")}: </strong>
        {state.status?.target ?? "..."} ({state.status?.platform}/{state.status?.arch})
        <div class="mt-1 text-text-weak">{state.status?.directory}</div>
        <Show when={props.remote}>
          <p class="mt-2 text-text-weak">{t("agentBackend.remote")}</p>
        </Show>
      </div>
      <label class="text-12-medium text-text-strong">
        {t("agentBackend.transport")}
        <select
          aria-label={t("agentBackend.transport")}
          class={selectClass}
          value={state.type}
          disabled={!!state.busy}
          onChange={(event) => change("type", event.currentTarget.value)}
        >
          <option value={props.advisor === "pi" ? "native-rpc" : "cli-json"}>
            {props.advisor === "pi" ? "Native RPC" : "CLI JSON"}
          </option>
          <option value="acp">ACP</option>
        </select>
      </label>
      <Show when={state.type === "acp"}>
        <label class="text-12-medium text-text-strong">
          {t("agentBackend.source")}
          <select
            aria-label={t("agentBackend.source")}
            class={selectClass}
            value={recipe() ? state.source : "custom"}
            disabled={!!state.busy}
            onChange={(event) => change("source", event.currentTarget.value)}
          >
            <Show when={recipe()}>
              <option value="managed">{t("agentBackend.managed")}</option>
            </Show>
            <option value="custom">{t("agentBackend.custom")}</option>
          </select>
        </label>
        <Show
          when={recipe() && state.source === "managed"}
          fallback={
            <Show when={!recipe()}>
              <p class="text-12-regular text-text-weak">{t("agentBackend.customOnly")}</p>
            </Show>
          }
        >
          <p class="text-12-regular break-all">
            {recipe()?.package}
            <br />
            <a href={recipe()?.source} target="_blank" rel="noreferrer" class="text-text-interactive-base underline">
              {recipe()?.source}
            </a>
          </p>
          <div class="text-12-regular text-text-weak">
            {t("agentBackend.dependencies")}: {recipe()?.requires.join(", ")}
            <br />
            Node: {state.status?.node || t("agentBackend.missing")}
            <br />
            npm: {state.status?.npm || t("agentBackend.missing")}
          </div>
          <label class="text-12-medium">
            {t("agentBackend.version")}
            <select
              aria-label={t("agentBackend.version")}
              class={selectClass}
              value={state.version}
              disabled={!!state.busy}
              onChange={(event) => change("version", event.currentTarget.value)}
            >
              <For each={recipe()?.releases}>
                {(version) => (
                  <option value={version}>
                    {version}
                    {version === recipe()?.recommended ? ` (${t("agentBackend.recommended")})` : ""}
                    {recipe()?.installed.some((item) => item.version === version)
                      ? ` · ${t("agentBackend.installed")}`
                      : ""}
                  </option>
                )}
              </For>
            </select>
          </label>
          <div class="flex flex-wrap gap-2">
            <Show
              when={
                recipe()?.installed.length &&
                !recipe()?.installed.some((item) => item.version === recipe()?.recommended)
              }
            >
              <Button
                size="small"
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
              variant="secondary"
              disabled={!!state.busy || !!installed()}
              onClick={() => void prepare("install")}
            >
              {t("agentBackend.install")}
            </Button>
            <Button
              size="small"
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
          <Show when={installed()}>
            <code class="text-11-regular break-all">{JSON.stringify(installed()?.command)}</code>
          </Show>
        </Show>
        <Show when={state.source === "custom" || !recipe()}>
          <TextField
            multiline
            label={t("agentBackend.command")}
            value={state.command}
            disabled={!!state.busy}
            onChange={(value) => change("command", value)}
            placeholder={'["/path/to/adapter", "--acp"]'}
          />
        </Show>
        <details class="text-12-regular">
          <summary class="cursor-pointer text-text-weak">{t("agentBackend.advanced")}</summary>
          <div class="mt-3 flex flex-col gap-3">
            <TextField
              multiline
              label={t("agentBackend.environment")}
              value={state.env}
              disabled={!!state.busy}
              onChange={(value) => change("env", value)}
            />
            <TextField
              label={t("agentBackend.model")}
              value={state.model}
              disabled={!!state.busy}
              onChange={(value) => change("model", value)}
            />
            <TextField
              label={t("agentBackend.mode")}
              value={state.mode}
              disabled={!!state.busy}
              onChange={(value) => change("mode", value)}
            />
            <label>
              {t("agentBackend.permission")}
              <select
                class={selectClass}
                value={state.permission}
                disabled={!!state.busy}
                onChange={(event) => change("permission", event.currentTarget.value)}
              >
                <option value="deny">{t("agentBackend.deny")}</option>
                <option value="ask">{t("agentBackend.ask")}</option>
              </select>
            </label>
          </div>
        </details>
        <p class="text-12-regular text-text-weak">{t("agentBackend.safety")}</p>
        <div class="flex flex-wrap gap-2">
          <Button
            size="small"
            variant="secondary"
            disabled={!!state.busy || (state.source === "managed" && !!recipe() && !installed())}
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
        </div>
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
                  void perform("commit", async (signal) => {
                    const token = confirmation().token
                    setState("confirmation", undefined)
                    const result = await props.client.agentBackend.commit({ token }, { signal, throwOnError: true })
                    setState({ status: result.data, confirmation: undefined, tested: "", result: undefined })
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
      <div class="flex flex-wrap items-center gap-2">
        <Button
          size="small"
          variant="primary"
          disabled={!!state.busy || (state.type === "acp" && !tested())}
          onClick={() => void save()}
        >
          {t("agentBackend.activate")}
        </Button>
        <Show when={state.busy}>
          <span role="status" class="text-12-regular text-text-weak">
            {t("agentBackend.working")}: {state.busy}
          </span>
          <Button size="small" variant="ghost" onClick={() => controller?.abort()}>
            {t("common.cancel")}
          </Button>
        </Show>
      </div>
      <p class="text-11-regular text-text-weak">{t("agentBackend.legacyHint")}</p>
    </section>
  )
}

export function RemoteAgentBackendSettings() {
  const { t } = useLanguage()
  const sdk = useGlobalSDK()
  const server = useServer()
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
      <select
        aria-label={t("agentBackend.advisor")}
        class="rounded-lg border border-border-weak-base bg-surface-base p-2"
        value={state.advisor}
        onChange={(event) => setState("advisor", event.currentTarget.value as AdvisorID)}
      >
        <For each={["claude", "codex", "pi", "grok", "dsh"] as AdvisorID[]}>
          {(id) => <option value={id}>{id}</option>}
        </For>
      </select>
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
