import { For, Show, createEffect, createMemo, on, untrack, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { mainDomain } from "@/pages/layout/extra-agents"
import { Persist, persisted } from "@/utils/persist"

type Channel = {
  channelName: string
  platform: "feishu" | "qq" | "discord" | "wechat"
  enabled: boolean
  running: boolean
  recipientStatus: "ready" | "missing" | "ambiguous" | "unsupported"
  recipient?: { name?: string }
}
type Subscription = {
  id: string
  sessionID: string
  target: { channelName: string }
  keyword?: string
  status: "active" | "paused" | "stopped" | "failed"
  failureReason?: string
}
type Session = { id: string; title: string; directory: string }

export function imSelectedProject(saved: string, current: string, directories: string[]) {
  if (directories.includes(saved)) return saved
  return directories.includes(current) ? current : ""
}

export async function imLoadBatch<C, W, S>(requests: {
  channels: () => Promise<C>
  subscriptions: () => Promise<W>
  sessions: () => Promise<S>
}) {
  return Promise.all([requests.channels(), requests.subscriptions(), requests.sessions()] as const)
}

const inputClass =
  "h-9 min-w-0 rounded-md border border-border-weak-base bg-background-base px-2.5 text-13-regular text-text-strong outline-none focus:border-border-strong-base"

export const ConfigIM: Component = () => {
  const t = useLanguage().t
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const [preferences, setPreferences, , preferencesReady] = persisted(
    Persist.global("config.im.service.v1"),
    createStore({ selectedDirectory: "" }),
  )
  const [state, setState] = createStore({
    channels: [] as Channel[],
    subscriptions: [] as Subscription[],
    sessions: [] as Session[],
    loading: false,
    error: "",
    busy: {} as Record<string, boolean>,
    form: { channelName: "", sessionID: "", keyword: "" },
  })
  const projects = createMemo(() => layout.projects.list().filter((p) => p.visibility !== "internal" && !!p.worktree))
  const directories = createMemo(() => projects().map((p) => p.worktree))
  const directory = createMemo(() =>
    preferencesReady()
      ? imSelectedProject(preferences.selectedDirectory, globalSync.data.path.directory ?? "", directories())
      : "",
  )
  const client = (value: string) =>
    globalSDK.forDomain(mainDomain).createClient({ directory: value, throwOnError: true })
  const readyChannels = createMemo(() =>
    state.channels.filter((c) => c.enabled && c.running && c.recipientStatus === "ready"),
  )
  let version = 0

  async function load(value: string) {
    const request = ++version
    setState({ loading: true, error: "", subscriptions: [], sessions: [] })
    console.info("[im-service-ui] load", { directory: value, request })
    try {
      const sdk = client(value)
      const [channels, subscriptions, sessions] = await imLoadBatch({
        channels: async () => (await sdk.im.channels({ directory: value || undefined })).data ?? [],
        subscriptions: async () => (value ? ((await sdk.im.subscription.list({ directory: value })).data ?? []) : []),
        sessions: async () =>
          value ? ((await sdk.session.list({ directory: value, roots: true, limit: 100 })).data ?? []) : [],
      })
      if (request !== version) return
      const ownSessions = sessions.filter((s) => s.directory === value)
      setState({ channels: [...channels], subscriptions: [...subscriptions], sessions: ownSessions, loading: false })
      if (!ownSessions.some((s) => s.id === state.form.sessionID))
        setState("form", "sessionID", ownSessions[0]?.id ?? "")
      if (!readyChannels().some((c) => c.channelName === state.form.channelName))
        setState("form", "channelName", readyChannels()[0]?.channelName ?? "")
      console.info("[im-service-ui] loaded", {
        directory: value,
        channels: state.channels.length,
        watches: state.subscriptions.length,
      })
    } catch (error) {
      if (request !== version) return
      setState({ loading: false, error: error instanceof Error ? error.message : String(error) })
      console.error("[im-service-ui] load failed", { directory: value, error: state.error })
    }
  }
  createEffect(
    on(
      () => [preferencesReady(), directory()] as const,
      ([ready, value]) => {
        if (!ready) return
        void untrack(() => load(value))
      },
    ),
  )
  createEffect(() => {
    if (!preferencesReady()) return
    const value = directory()
    if (value && !preferences.selectedDirectory) setPreferences("selectedDirectory", value)
  })

  async function createWatch() {
    const value = directory()
    if (!value || !state.form.sessionID || !state.form.channelName || state.busy.create) return
    setState("busy", "create", true)
    setState("error", "")
    console.info("[im-service-ui] watch create", {
      directory: value,
      channelName: state.form.channelName,
      sessionID: state.form.sessionID,
    })
    try {
      await client(value).im.subscription.create({
        directory: value,
        sessionID: state.form.sessionID,
        channelName: state.form.channelName,
        keyword: state.form.keyword.trim() || undefined,
      })
      if (directory() === value) await load(value)
    } catch (error) {
      if (directory() === value) setState("error", error instanceof Error ? error.message : String(error))
      console.error("[im-service-ui] watch create failed", { directory: value, error: String(error) })
    } finally {
      setState("busy", "create", false)
    }
  }
  async function changeWatch(watch: Subscription, action: "pause" | "resume" | "stop") {
    const value = directory()
    if (!value || state.busy[watch.id]) return
    setState("busy", watch.id, true)
    setState("error", "")
    console.info("[im-service-ui] watch action", { directory: value, subscriptionID: watch.id, action })
    try {
      await client(value).im.subscription[action]({ directory: value, subscriptionID: watch.id })
      if (directory() === value) await load(value)
    } catch (error) {
      if (directory() === value) setState("error", error instanceof Error ? error.message : String(error))
      console.error("[im-service-ui] watch action failed", { directory: value, action, error: String(error) })
    } finally {
      setState("busy", watch.id, false)
    }
  }
  return (
    <div class="flex flex-col gap-6 px-4 py-6 md:px-8">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-16-semibold text-text-strong">{t("config.im.title")}</h2>
          <p class="mt-1 text-13-regular text-text-weak">{t("config.im.header")}</p>
        </div>
        <Button size="small" variant="secondary" disabled={state.loading} onClick={() => void load(directory())}>
          {t("config.im.refresh")}
        </Button>
      </div>
      <Show when={state.error}>
        <div
          role="alert"
          class="rounded-lg border border-border-danger-base px-3 py-2 text-13-regular text-text-danger"
        >
          {state.error}
        </div>
      </Show>
      <section class="flex flex-col gap-3">
        <h3 class="text-14-semibold text-text-strong">{t("config.im.channels")}</h3>
        <p class="text-13-regular text-text-weak">{t("config.im.channelHelp")}</p>
        <For
          each={state.channels}
          fallback={
            <p class="text-13-regular text-text-weak">
              {state.loading ? t("config.im.loading") : t("config.im.channels.empty")}
            </p>
          }
        >
          {(channel) => (
            <div class="flex flex-col gap-2 rounded-xl border border-border-weak-base bg-surface-base p-4">
              <div class="flex flex-wrap items-baseline justify-between gap-2">
                <strong class="text-14-semibold text-text-strong">{channel.channelName}</strong>
                <span class="text-12-regular text-text-weak">
                  {channel.platform} ·{" "}
                  {t(
                    channel.enabled
                      ? channel.running
                        ? "config.im.channel.running"
                        : "config.im.channel.offline"
                      : "config.im.channel.disabled",
                  )}
                </span>
              </div>
              <p class="text-13-regular text-text-weak">
                {t(`config.im.recipient.${channel.recipientStatus}`)}
                {channel.recipient?.name ? ` · ${channel.recipient.name}` : ""}
              </p>
              <Show when={channel.recipientStatus === "ready"}>
                <code class="break-all text-12-regular text-text-strong">{`im_send({channelName: ${JSON.stringify(channel.channelName)}, text: "..."})`}</code>
              </Show>
            </div>
          )}
        </For>
      </section>
      <label class="flex max-w-xl flex-col gap-1.5 text-13-medium text-text-strong">
        {t("config.im.project")}
        <select
          aria-label={t("config.im.project")}
          class={inputClass}
          value={directory()}
          onChange={(event) => {
            const value = event.currentTarget.value
            console.info("[im-service-ui] project selected", { directory: value })
            setPreferences("selectedDirectory", value)
          }}
        >
          <option value="">{t("config.im.project.empty")}</option>
          <For each={directories()}>
            {(value) => (
              <option value={value}>
                {projects().find((p) => p.worktree === value)?.name || value.split(/[\\/]/).filter(Boolean).at(-1)}
              </option>
            )}
          </For>
        </select>
        <span class="text-12-regular text-text-weak">{t("config.im.projectHelp")}</span>
      </label>
      <Show when={directory()}>
        <section class="flex flex-col gap-3">
          <h3 class="text-14-semibold text-text-strong">{t("config.im.subscriptions")}</h3>
          <Show
            when={readyChannels().length && state.sessions.length}
            fallback={<p class="text-13-regular text-text-weak">{t("config.im.subscription.emptyCreate")}</p>}
          >
            <div class="grid gap-2 rounded-xl border border-border-weak-base p-4 sm:grid-cols-2">
              <select
                aria-label={t("config.im.subscription.session")}
                class={inputClass}
                value={state.form.sessionID}
                onChange={(e) => setState("form", "sessionID", e.currentTarget.value)}
              >
                <For each={state.sessions}>{(s) => <option value={s.id}>{s.title || s.id}</option>}</For>
              </select>
              <select
                aria-label={t("config.im.channels")}
                class={inputClass}
                value={state.form.channelName}
                onChange={(e) => setState("form", "channelName", e.currentTarget.value)}
              >
                <For each={readyChannels()}>{(c) => <option value={c.channelName}>{c.channelName}</option>}</For>
              </select>
              <input
                class={inputClass}
                placeholder={t("config.im.subscription.keyword")}
                value={state.form.keyword}
                onInput={(e) => setState("form", "keyword", e.currentTarget.value)}
              />
              <Button
                size="small"
                variant="primary"
                disabled={state.busy.create || !state.form.sessionID || !state.form.channelName}
                onClick={() => void createWatch()}
              >
                {t("config.im.subscription.create")}
              </Button>
            </div>
          </Show>
          <For
            each={state.subscriptions}
            fallback={<p class="text-13-regular text-text-weak">{t("config.im.subscription.none")}</p>}
          >
            {(watch) => (
              <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-weak-base p-3">
                <div class="min-w-0">
                  <div class="text-13-medium text-text-strong">{watch.target.channelName}</div>
                  <div class="text-12-regular text-text-weak">
                    {state.sessions.find((s) => s.id === watch.sessionID)?.title || watch.sessionID} ·{" "}
                    {t(`config.im.subscription.status.${watch.status}`)}
                    {watch.keyword ? ` · ${watch.keyword}` : ""}
                  </div>
                  <Show when={watch.failureReason}>
                    <p class="text-12-regular text-text-danger">{watch.failureReason}</p>
                  </Show>
                </div>
                <div class="flex gap-1">
                  <Show when={watch.status === "active"}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={state.busy[watch.id]}
                      onClick={() => void changeWatch(watch, "pause")}
                    >
                      {t("config.im.subscription.pause")}
                    </Button>
                  </Show>
                  <Show when={watch.status === "paused" || watch.status === "failed"}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={state.busy[watch.id]}
                      onClick={() => void changeWatch(watch, "resume")}
                    >
                      {t("config.im.subscription.resume")}
                    </Button>
                  </Show>
                  <Show when={watch.status !== "stopped"}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={state.busy[watch.id]}
                      onClick={() => void changeWatch(watch, "stop")}
                    >
                      {t("config.im.subscription.stop")}
                    </Button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </section>
      </Show>
    </div>
  )
}
