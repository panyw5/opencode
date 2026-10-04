import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Switch } from "@opencode-ai/ui/switch"
import { Icon } from "@opencode-ai/ui/icon"
import { getDirectory } from "@opencode-ai/core/util/path"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { DEFAULT_GPT_PRO_CONFIG, type GptProConfig, type GptProJob } from "@opencode-ai/util/gpt-pro"

export function GptProSettings(props: { onConfig?: (config: GptProConfig) => void }) {
  const platform = usePlatform()
  const api = platform.gptPro
  const t = useLanguage().t
  const [state, set] = createStore({
    config: { ...DEFAULT_GPT_PRO_CONFIG },
    phase: "",
    login: "",
    extensionDirectory: "",
    jobs: [] as GptProJob[],
    error: "",
    busy: false,
  })
  let disposed = false
  const refresh = async () => {
    if (!api) return
    try {
      const [config, status, login, jobs] = await Promise.all([
        api.getConfig(),
        api.status(),
        api.loginStatus(),
        api.list(),
      ])
      if (disposed) return
      set({
        config,
        phase: status.page?.composer && !status.page.error ? t("gptPro.loggedIn") : (status.detail ?? status.phase),
        login: login.phase,
        extensionDirectory: login.extensionDirectory ?? "",
        jobs: jobs.slice().reverse().slice(0, 10),
      })
      props.onConfig?.(config)
    } catch (error) {
      if (!disposed) set("error", String(error))
    }
  }
  const run = async (action: () => Promise<unknown>) => {
    set({ busy: true, error: "" })
    try {
      await action()
      await refresh()
    } catch (error) {
      set("error", String(error))
    } finally {
      set("busy", false)
    }
  }
  const save = (config: GptProConfig) =>
    run(async () => {
      if (!api) return
      const result = await api.setConfig(config)
      set("config", result)
      props.onConfig?.(result)
      window.dispatchEvent(new CustomEvent("gpt-pro:changed"))
    })
  onMount(() => {
    void refresh()
    const timer = setInterval(() => {
      if (!state.busy) void refresh()
    }, 3000)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
    })
  })
  return (
    <div class="h-full overflow-y-auto p-6" data-component="gpt-pro-settings">
      <div class="flex flex-wrap items-start justify-between gap-3" data-section="gpt-pro-header">
        <h2 class="min-w-0 text-20-medium text-text-strong">
          GPT-6 Pro <span class="text-12-regular text-text-weak">Chat</span>
        </h2>
        <Switch
          checked={state.config.enabled}
          disabled={state.busy}
          onChange={(enabled) => void save({ ...state.config, enabled })}
          title={t("gptPro.enabled")}
        >
          {t("config.claws.field.enabled")}
        </Switch>
      </div>
      <p class="mt-3 text-13-regular text-text-weak">{t("gptPro.description")}</p>
      <div class="mt-6 flex flex-col gap-5 rounded-xl border border-border-weak-base bg-surface-base p-5">
        <label class="flex items-center justify-between gap-4 text-13-regular">
          {t("gptPro.timeout")}
          <input
            aria-label={t("gptPro.timeout")}
            type="number"
            min="1"
            max="60"
            class="w-20 rounded border border-border-weak-base p-2"
            value={state.config.timeoutMinutes}
            onChange={(event) => void save({ ...state.config, timeoutMinutes: Number(event.currentTarget.value) })}
          />
        </label>
        <div class="text-12-regular text-text-weak">{t("gptPro.persistence")}</div>
        <div class="flex flex-wrap gap-3">
          <Button disabled={!api || state.busy} onClick={() => void run(() => api!.open())}>
            {t("gptPro.open")}
          </Button>
          <Button
            variant="secondary"
            disabled={!api || state.busy}
            onClick={() => void run(() => api!.loginInBrowser())}
          >
            {t("gptPro.login")}
          </Button>
          <Button variant="ghost" disabled={!api || state.busy} onClick={() => void refresh()}>
            {t("gptPro.refresh")}
          </Button>
        </div>
        <section class="@container border-t border-border-weak-base pt-4" data-section="gpt-pro-login-guide">
          <h3 class="text-14-medium text-text-strong">{t("gptPro.guide.title")}</h3>
          <ol
            class="mt-4 mb-5 grid grid-cols-1 gap-8 @[48rem]:grid-cols-4"
            aria-label={t("gptPro.guide.flow")}
            data-section="gpt-pro-login-flow"
          >
            <For
              each={
                [
                  "gptPro.guide.flow.install",
                  "gptPro.guide.flow.open",
                  "gptPro.guide.flow.login",
                  "gptPro.guide.flow.approve",
                ] as const
              }
            >
              {(step, index) => (
                <li class="relative flex min-w-0 items-center gap-3 rounded-lg border border-border-weak-base bg-background-base p-3">
                  <Show when={index() > 0}>
                    <span
                      aria-hidden="true"
                      class="absolute -top-6 left-1/2 -translate-x-1/2 rotate-90 text-icon-weak @[48rem]:top-1/2 @[48rem]:-left-6 @[48rem]:translate-x-0 @[48rem]:-translate-y-1/2 @[48rem]:rotate-0"
                    >
                      <Icon name="arrow-right" size="small" />
                    </span>
                  </Show>
                  <span
                    aria-hidden="true"
                    class="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-inset-base text-[18px] font-medium leading-none text-text-strong"
                  >
                    {index() + 1}
                  </span>
                  <span class="min-w-0 text-12-medium leading-5 text-text-strong">{t(step)}</span>
                </li>
              )}
            </For>
          </ol>
          <ol
            class="mt-3 list-decimal space-y-3 pl-5 text-12-regular leading-relaxed text-text-weak"
            data-section="gpt-pro-login-steps"
          >
            <li>{t("gptPro.guide.install")}</li>
            <li>
              {t("gptPro.guide.load")}
              <Show when={state.extensionDirectory}>
                <div class="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-border-weak-base bg-background-base p-3">
                  <code class="min-w-0 flex-1 basis-64 break-all select-text text-text-base">
                    {state.extensionDirectory}
                  </code>
                  <Show when={platform.openPath}>
                    <Button
                      variant="ghost"
                      size="small"
                      icon="folder"
                      class="ml-auto shrink-0"
                      disabled={state.busy}
                      onClick={() =>
                        void run(async () => {
                          const parent = getDirectory(state.extensionDirectory)
                          console.debug(`[gpt-pro-settings] opening extension parent directory=${parent}`)
                          await platform.openPath!(parent)
                          console.debug("[gpt-pro-settings] extension parent directory opened")
                        })
                      }
                    >
                      {t("gptPro.guide.openDirectory")}
                    </Button>
                  </Show>
                </div>
              </Show>
            </li>
            <li>{t("gptPro.guide.login")}</li>
            <li>{t("gptPro.guide.signIn")}</li>
            <li>{t("gptPro.guide.openExtension")}</li>
            <li>{t("gptPro.guide.approve")}</li>
            <li>{t("gptPro.guide.finish")}</li>
            <li>{t("gptPro.guide.selectModel")}</li>
          </ol>
          <p class="mt-3 text-11-regular leading-relaxed text-text-weak">{t("gptPro.guide.note")}</p>
        </section>
        <div class="text-12-regular">
          {t("gptPro.status")}: {state.phase || "..."} / {state.login}
        </div>
        <Show when={state.error}>
          <p class="text-12-regular text-text-critical-base" role="alert">
            {state.error}
          </p>
        </Show>
      </div>
      <Collapsible variant="ghost" class="mt-7" defaultOpen={false} forceMount={false} data-section="gpt-pro-history">
        <Collapsible.Trigger class="flex w-full items-center justify-between gap-2 py-2 text-14-medium text-text-strong">
          {t("gptPro.history")}
          <Collapsible.Arrow style={{ opacity: 1 }} />
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div class="mt-3 flex flex-col gap-2">
            <For each={state.jobs}>
              {(job) => (
                <button
                  type="button"
                  class="rounded-lg border border-border-weak-base p-3 text-start hover:bg-surface-secondary"
                  onClick={() => void run(() => api!.command({ action: "open", id: job.id }))}
                >
                  <div class="text-12-medium">
                    {job.phase} · {job.prompt.slice(0, 90)}
                  </div>
                  <div class="mt-1 text-11-regular text-text-weak">{job.id}</div>
                </button>
              )}
            </For>
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}
