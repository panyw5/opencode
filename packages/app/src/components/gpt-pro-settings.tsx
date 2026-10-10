import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Switch } from "@opencode-ai/ui/switch"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { handoffGptPro } from "@opencode-ai/ui/gpt-pro-handoff"
import { resolveGptProView, type GptProCachedResult } from "@opencode-ai/ui/gpt-pro-result"
import { GptProResultPreviewDialog, type GptProResultPreviewState } from "@opencode-ai/ui/gpt-pro-result-preview"
import { GptProErrorNotice } from "@opencode-ai/ui/gpt-pro-error-notice"
import type { GptProIssueCode } from "@opencode-ai/util/gpt-pro-error"
import { getDirectory } from "@opencode-ai/core/util/path"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { DEFAULT_GPT_PRO_CONFIG, type GptProConfig, type GptProJob } from "@opencode-ai/util/gpt-pro"

export function GptProSettings(props: { onConfig?: (config: GptProConfig) => void }) {
  const platform = usePlatform()
  const api = platform.gptPro
  const t = useLanguage().t
  const installGuide = t("gptPro.guide.install").split("chrome://extensions")
  const [state, set] = createStore({
    config: { ...DEFAULT_GPT_PRO_CONFIG },
    login: "",
    loginError: "",
    refreshError: "",
    extensionDirectory: "",
    jobs: [] as GptProJob[],
    result: {
      open: false,
      loading: false,
      opening: false,
      error: "",
      errorCode: undefined as GptProIssueCode | undefined,
      originalURL: undefined as string | undefined,
      jobID: undefined as string | undefined,
      result: undefined as GptProCachedResult | undefined,
    },
    error: "",
    busy: false,
  })
  let disposed = false
  const refresh = async () => {
    if (!api) return
    try {
      const [config, login, jobs] = await Promise.all([api.getConfig(), api.loginStatus(), api.list()])
      if (disposed) return
      set({
        config,
        login: login.phase,
        loginError: login.error ?? "",
        refreshError: "",
        extensionDirectory: login.extensionDirectory ?? "",
        jobs: jobs.slice().reverse().slice(0, 10),
      })
      props.onConfig?.(config)
    } catch (error) {
      console.warn(`[gpt-pro-settings] status refresh failed`)
      if (!disposed) set("refreshError", String(error))
    }
  }
  const run = async (action: () => Promise<unknown>) => {
    set({ busy: true, error: "" })
    try {
      await action()
      await refresh()
    } catch (error) {
      console.warn(`[gpt-pro-settings] action failed`)
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
  const importStatus = () => {
    if (state.login === "imported") return t("gptPro.importStatus.success")
    if (state.login === "failed") return t("gptPro.importStatus.failed")
    return t("gptPro.importStatus.notImported")
  }
  const viewHistory = async (job: GptProJob) => {
    if (!api || state.busy) return
    set("busy", true)
    set("error", "")
    set("result", {
      open: false,
      loading: false,
      opening: false,
      error: "",
      originalURL: job.url,
      jobID: job.id,
      result: undefined,
    })
    console.debug(`[gpt-pro-settings] resolving history View id=${job.id} phase=${job.phase}`)
    try {
      const resolution = await resolveGptProView(api, job.id)
      if (disposed) return
      if (resolution.kind === "cached") {
        set("busy", false)
        set("result", {
          open: true,
          loading: false,
          opening: false,
          error: "",
          originalURL: resolution.result.url || job.url,
          jobID: resolution.result.id,
          result: resolution.result,
        })
        return
      }
      if (resolution.kind === "unavailable") {
        set("busy", false)
        set("result", {
          open: true,
          loading: false,
          opening: false,
          error: resolution.error || t("gptPro.resultUnavailable"),
          errorCode: resolution.errorCode,
          originalURL: resolution.url || job.url,
          jobID: resolution.id,
          result: undefined,
        })
        return
      }
      set("result", {
        open: false,
        loading: false,
        opening: false,
        error: "",
        originalURL: undefined,
        jobID: undefined,
        result: undefined,
      })
      await handoffGptPro(api, resolution.job.id)
      set("busy", false)
    } catch (error) {
      if (!disposed) {
        console.warn(`[gpt-pro-settings] history View failed id=${job.id} error=${String(error)}`)
        set("busy", false)
        set("result", {
          open: true,
          loading: false,
          opening: false,
          error: t("gptPro.resultUnavailable"),
          originalURL: job.url,
          jobID: job.id,
          result: undefined,
        })
      }
    }
  }
  const closeResult = () => {
    if (disposed) return
    set("result", {
      open: false,
      loading: false,
      opening: false,
      error: "",
      originalURL: undefined,
      jobID: undefined,
      result: undefined,
    })
  }
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
    <div class="flex h-full min-h-0 flex-col" data-component="gpt-pro-settings">
      <div
        class="flex flex-wrap items-start justify-between gap-3 border-b border-border-weak-base px-4 py-4"
        data-section="gpt-pro-header"
      >
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="min-w-0 text-20-medium text-text-strong">
              GPT-6 Pro <span class="text-12-regular text-text-weak">Chat</span>
            </h2>
            <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-text-weak">
              {state.config.enabled ? t("config.claws.badge.enabled") : t("config.claws.badge.disabled")}
            </span>
          </div>
          <p class="mt-2 text-13-regular text-text-weak">{t("gptPro.description")}</p>
        </div>
        <Switch
          checked={state.config.enabled}
          disabled={state.busy}
          onChange={(enabled) => void save({ ...state.config, enabled })}
          title={t("gptPro.enabled")}
        >
          {t("config.claws.field.enabled")}
        </Switch>
      </div>
      <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        <div class="flex w-full flex-col gap-6">
          <section
            class="rounded-2xl border border-border-weak-base bg-surface-base p-4"
            data-section="gpt-pro-login"
          >
            <h3 class="text-14-medium text-text-strong">{t("gptPro.loginSection")}</h3>
            <div class="mt-4 flex flex-wrap items-center justify-start gap-2">
              <Button
                size="small"
                variant="secondary"
                disabled={!api || state.busy}
                onClick={() => void run(() => api!.loginInBrowser())}
              >
                {t("gptPro.login")}
              </Button>
              <div class="inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border-weak-base bg-background-base py-0.5 pl-3 pr-1">
                <span class="text-12-regular text-text-weak">{t("gptPro.importStatus.label")}:</span>
                <span
                  class="text-12-regular"
                  classList={{
                    "text-text-success-base": state.login === "imported",
                    "text-text-danger-base": state.login === "failed",
                    "text-text-weak": state.login !== "imported" && state.login !== "failed",
                  }}
                >
                  {importStatus()}
                </span>
                <Button
                  size="small"
                  variant="ghost"
                  class="shrink-0 rounded-full"
                  disabled={!api || state.busy}
                  onClick={() => void refresh()}
                >
                  {t("gptPro.refresh")}
                </Button>
              </div>
              <Show when={state.login === "imported"}>
                <Button
                  size="small"
                  class="ml-auto"
                  disabled={!api || state.busy}
                  onClick={() => void run(() => api!.open())}
                >
                  {t("gptPro.open")}
                </Button>
              </Show>
            </div>
            <Show when={state.error || state.refreshError || ["failed", "expired"].includes(state.login)}>
              <GptProErrorNotice
                error={state.error || state.refreshError || state.loginError}
                code={state.error ? undefined : state.refreshError ? "connection" : state.login === "expired" ? "login_expired" : undefined}
                busy={state.busy}
              />
            </Show>
            <div class="mt-4 border-t border-border-weak-base pt-4">
              <h4 class="text-13-medium text-text-strong">{t("gptPro.guide.title")}</h4>
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
                <li>
                  {installGuide[0]}
                  <a
                    href="chrome://extensions"
                    class="text-text-base underline underline-offset-2 hover:text-text-strong"
                    aria-label={t("common.copy")}
                    title={t("common.copy")}
                    onClick={async (event) => {
                      event.preventDefault()
                      set("error", "")
                      console.debug("[gpt-pro-settings] copying Chrome extensions address")
                      try {
                        await navigator.clipboard.writeText("chrome://extensions")
                        console.debug("[gpt-pro-settings] Chrome extensions address copied")
                        showToast({ title: t("session.share.copy.copied") })
                      } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        console.debug(`[gpt-pro-settings] copying Chrome extensions address failed: ${message}`)
                        set("error", message)
                      }
                    }}
                  >
                    chrome://extensions
                  </a>
                  {installGuide[1]}
                </li>
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
            </div>
          </section>
          <section
            class="rounded-2xl border border-border-weak-base bg-surface-base p-4"
            data-section="gpt-pro-settings"
          >
            <h3 class="text-14-medium text-text-strong">{t("gptPro.configSection")}</h3>
            <div class="mt-4 grid gap-4 md:grid-cols-2">
              <div class="space-y-2">
                <label class="flex items-center justify-between gap-4 text-13-regular">
                  {t("gptPro.timeout")}
                  <input
                    aria-label={t("gptPro.timeout")}
                    type="number"
                    min="1"
                    max="60"
                    class="h-8 w-20 rounded-lg border border-border-weak-base bg-background-base px-2.5 text-13-regular text-text-base"
                    value={state.config.timeoutMinutes}
                    onChange={(event) =>
                      void save({ ...state.config, timeoutMinutes: Number(event.currentTarget.value) })
                    }
                  />
                </label>
                <p class="text-12-regular text-text-weak">{t("gptPro.persistence")}</p>
              </div>
              <label class="flex items-center justify-between gap-4 text-13-regular">
                {t("gptPro.progressInterval")}
                <input
                  aria-label={t("gptPro.progressInterval")}
                  type="number"
                  min="10"
                  max="600"
                  class="h-8 w-20 rounded-lg border border-border-weak-base bg-background-base px-2.5 text-13-regular text-text-base"
                  value={state.config.progressIntervalSeconds ?? 60}
                  onChange={(event) =>
                    void save({ ...state.config, progressIntervalSeconds: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label class="flex items-center justify-between gap-4 text-13-regular">
                {t("gptPro.maxConcurrent")}
                <input
                  aria-label={t("gptPro.maxConcurrent")}
                  type="number"
                  min="1"
                  max="8"
                  class="h-8 w-20 rounded-lg border border-border-weak-base bg-background-base px-2.5 text-13-regular text-text-base"
                  value={state.config.maxConcurrent ?? 4}
                  onChange={(event) =>
                    void save({ ...state.config, maxConcurrent: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label class="flex items-center justify-between gap-4 text-13-regular">
                {t("gptPro.maxResidentPages")}
                <input
                  aria-label={t("gptPro.maxResidentPages")}
                  type="number"
                  min={state.config.maxConcurrent ?? 4}
                  max="32"
                  class="h-8 w-20 rounded-lg border border-border-weak-base bg-background-base px-2.5 text-13-regular text-text-base"
                  value={state.config.maxResidentPages ?? 8}
                  onChange={(event) =>
                    void save({ ...state.config, maxResidentPages: Number(event.currentTarget.value) })
                  }
                />
              </label>
            </div>
          </section>
        </div>
      </div>
      <Collapsible
        variant="ghost"
        class="mx-4 mb-4"
        defaultOpen={false}
        forceMount={false}
        data-section="gpt-pro-history"
      >
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
                  aria-label={`${t("gptPro.viewResult")}: ${job.id}`}
                  class="rounded-lg border border-border-weak-base p-3 text-start hover:bg-surface-secondary"
                  onClick={() => void viewHistory(job)}
                >
                  <div class="text-12-medium">
                    {job.phase} · {job.ownerPage?.sessionID ?? "manual"} · page {job.pageID?.slice(-8) ?? "legacy"}
                  </div>
                  <div class="mt-1 text-11-regular text-text-weak">{job.prompt.slice(0, 90)}</div>
                  <div class="mt-1 text-11-regular text-text-weak">{job.id}</div>
                  <div class="mt-2 text-11-medium text-text-base">{t("gptPro.viewResult")}</div>
                </button>
              )}
            </For>
          </div>
        </Collapsible.Content>
      </Collapsible>
      <Show when={state.result.open}>
        <GptProResultPreviewDialog
          state={state.result as GptProResultPreviewState}
          client={api!}
          jobID={state.result.jobID}
          onClose={closeResult}
        />
      </Show>
    </div>
  )
}
