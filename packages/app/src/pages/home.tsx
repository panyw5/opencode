import type { GlobalSession, ScheduledTask } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Logo } from "@opencode-ai/ui/logo"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useNavigate } from "@solidjs/router"
import { DateTime } from "luxon"
import { createEffect, createMemo, createRenderEffect, createResource, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { DialogRecentSessions } from "@/components/dialog-recent-sessions"
import {
  latestUserMessageText,
  mergeRecentSessions,
  RECENT_SESSION_LIMIT,
} from "@/components/dialog-recent-sessions-utils"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSessionTabs } from "@/context/session-tabs"
import { HomePathInput } from "@/pages/home-path-input"
import "./home.css"

const HOME_SESSION_LIMIT = 6
const HOME_TASK_LIMIT = 10

function SectionHeader(props: { id: string; title: string; action?: string; onAction?: () => void }) {
  return (
    <div class="home-section-header flex min-h-8 items-center justify-between gap-3 border-b border-border-weak-base pb-2">
      <h2 id={props.id} class="text-13-medium text-text-strong">
        {props.title}
      </h2>
      <Show when={props.action && props.onAction}>
        <Button size="small" variant="ghost" class="-mr-2 px-2 text-12-regular text-text-weak" onClick={props.onAction}>
          {props.action}
          <Icon name="arrow-right" size="small" />
        </Button>
      </Show>
    </div>
  )
}

export default function Home() {
  const mountedAt = performance.now()
  const navClickAt = (window as Window & { __homeNavClickAt?: number }).__homeNavClickAt
  const sinceClick = typeof navClickAt === "number" ? `${(mountedAt - navClickAt).toFixed(1)}ms` : "n/a"
  console.debug(`[home-perf] component-start at=${mountedAt.toFixed(1)}ms sinceClick=${sinceClick}`)
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const sessionTabs = useSessionTabs()
  const homedir = createMemo(() => sync.data.path.home)
  const latestProject = createMemo(() =>
    sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .at(0)?.worktree,
  )
  const warmed = createMemo(() => {
    const last = server.projects.last()
    if (last) return [last]
    const latest = latestProject()
    return latest ? [latest] : []
  })
  createResource(
    () => (sync.ready ? warmed() : undefined),
    async (dirs) => {
      const started = performance.now()
      console.debug(`[home-perf] warm-start sinceClick=${typeof navClickAt === "number" ? `${(started - navClickAt).toFixed(1)}ms` : "n/a"} dirs=${dirs.length}`)
      await Promise.allSettled(
        dirs.map(async (dir) => {
          sync.child(dir, { bootstrap: true })
          await Promise.race([sync.project.loadSessions(dir, { silent: true }), new Promise((resolve) => setTimeout(resolve, 1500))])
        }),
      )
      console.debug(`[home-perf] warm-end duration=${(performance.now() - started).toFixed(1)}ms dirs=${dirs.length}`)
    },
  )

  const dashboardSource = createMemo(() => (sync.ready ? `${server.domain}:${sdk.version}` : undefined))
  const loadRecentSessions = async () => {
    const result = await sdk.client.experimental.session.list({ roots: true, limit: RECENT_SESSION_LIMIT })
    return mergeRecentSessions([result.data ?? []])
  }
  const [sessions, { refetch: refetchSessions }] = createResource(dashboardSource, loadRecentSessions)
  const homeSessions = createMemo(() => (sessions() ?? []).slice(0, HOME_SESSION_LIMIT))
  const [latestUserMessages, setLatestUserMessages] = createStore<Record<string, string | undefined>>({})
  let previewGeneration = 0
  createEffect(() => {
    const items = homeSessions().map((session) => ({ id: session.id, directory: session.directory }))
    const generation = ++previewGeneration
    const started = performance.now()
    console.debug(`[home-perf] previews-start at=${started.toFixed(1)}ms sessions=${items.length}`)
    void Promise.all(
      items.map(async (session) => {
        console.debug(`[home-recent] loading latest user message session=${session.id} directory=${session.directory}`)
        try {
          let before: string | undefined
          for (let page = 1; page <= 5; page++) {
            const result = await sdk.client.session.messages({
              sessionID: session.id,
              directory: session.directory,
              limit: 20,
              before,
            })
            const text = latestUserMessageText(result.data ?? [])
            console.debug(
              `[home-recent] loaded message page session=${session.id} page=${String(page)} count=${String(result.data?.length ?? 0)} preview=${text ? "yes" : "no"}`,
            )
            if (text) return [session.id, text] as const
            before = result.response.headers.get("x-next-cursor") ?? undefined
            if (!before) break
          }
          return [session.id, undefined] as const
        } catch (error) {
          console.error(`[home-recent] failed latest user message session=${session.id} directory=${session.directory}`, error)
          return [session.id, undefined] as const
        }
      }),
    ).then((previews) => {
      if (generation !== previewGeneration) return
      console.debug(`[home-perf] previews-end duration=${(performance.now() - started).toFixed(1)}ms sessions=${items.length}`)
      setLatestUserMessages(reconcile(Object.fromEntries(previews) as Record<string, string | undefined>))
    })
  })
  onCleanup(() => previewGeneration++)
  const [tasks, { refetch: refetchTasks }] = createResource(dashboardSource, async () => {
    const result = await sdk.client.scheduledTask.list()
    return (result.data ?? [])
      .filter((task) => task.enabled && task.nextRunAt)
      .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))
      .slice(0, HOME_TASK_LIMIT)
  })

  const stop = sdk.listenAll((event) => {
    if (event.details.type.startsWith("scheduled-task.")) void refetchTasks()
    if (event.details.type.startsWith("session.")) void refetchSessions()
  })
  onCleanup(stop)

  let sent = false
  createRenderEffect(() => {
    if (sent || !sync.ready) return
    sent = true
    console.debug(`[home-perf] sync-ready duration=${(performance.now() - mountedAt).toFixed(1)}ms`)
    queueMicrotask(() => window.dispatchEvent(new CustomEvent("opencode:startup-interactive")))
  })

  const firstFrame = requestAnimationFrame(() => {
    console.debug(`[home-perf] first-frame duration=${(performance.now() - mountedAt).toFixed(1)}ms`)
  })
  onCleanup(() => cancelAnimationFrame(firstFrame))

  const serverDotClass = createMemo(() => {
    const healthy = server.healthy()
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  const displayPath = (directory: string) => directory.replace(homedir(), "~")
  const relativeTime = (value: number) =>
    DateTime.fromMillis(value).setLocale(language.intl()).toRelative() ?? new Date(value).toLocaleString(language.intl())

  function openProject(directory: string) {
    sessionTabs.restoreDirectory(directory)
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  function openSession(session: GlobalSession) {
    const root = session.project?.worktree ?? session.directory
    layout.projects.open(root)
    server.projects.touch(root)
    sessionTabs.ensureOpen({
      directory: session.directory,
      id: session.id,
      title: session.title,
      parentID: session.parentID,
    })
    navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  function showRecentSessions() {
    dialog.show(
      () => <DialogRecentSessions load={loadRecentSessions} onSelect={openSession} />,
      undefined,
      { modal: false, preventScroll: false },
    )
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) openProject(directory)
        return
      }
      if (result) openProject(result)
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
      return
    }
    dialog.show(
      () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
      () => resolve(null),
    )
  }

  function taskTone(task: ScheduledTask) {
    if (task.lastStatus === "error") return "bg-icon-critical-base"
    if (task.lastStatus === "running" || task.lastStatus === "retrying") return "bg-icon-warning-base"
    if (task.lastStatus === "ok") return "bg-icon-success-base"
    return "bg-border-strong-base"
  }

  function taskStatus(task: ScheduledTask) {
    if (task.lastStatus === "error") return language.t("home.upcomingTasks.status.error")
    if (task.lastStatus === "running" || task.lastStatus === "retrying")
      return language.t("home.upcomingTasks.status.running")
    if (task.lastStatus === "ok") return language.t("home.upcomingTasks.status.ready")
    return language.t("home.upcomingTasks.status.scheduled")
  }

  return (
    <div
      ref={() => {
        const visibleAt = performance.now()
        console.debug(`[home-perf] dom-created sinceClick=${typeof navClickAt === "number" ? `${(visibleAt - navClickAt).toFixed(1)}ms` : "n/a"}`)
      }}
      data-component="home-shell"
      class="size-full overflow-y-auto bg-background-base"
    >
      <main data-component="home-dashboard" class="mx-auto w-full max-w-6xl px-4 py-7 sm:px-6 md:py-10 lg:px-8">
        <header class="home-masthead flex items-start justify-between gap-6">
          <div class="min-w-0">
            <Logo class="home-logo h-auto w-36 opacity-70" />
            <h1 class="sr-only">{language.t("home.title")}</h1>
            <p class="mt-3 max-w-xl text-13-regular text-text-weak">{language.t("home.subtitle")}</p>
          </div>
          <Button
            size="normal"
            variant="ghost"
            class="home-server shrink-0 text-12-regular text-text-weak"
            onClick={() => dialog.show(() => <DialogSelectServer />)}
          >
            <span class={`size-2 rounded-full ${serverDotClass()}`} aria-hidden="true" />
            {server.name}
          </Button>
        </header>

        <section class="home-command-deck relative z-10 mt-8 rounded-2xl border border-border-weak-base bg-surface-raised-base p-4 shadow-sm sm:p-5">
          <div class="mb-4">
            <h2 class="text-15-medium text-text-strong">{language.t("home.quickAdd.title")}</h2>
          </div>
          <HomePathInput home={homedir()} onOpen={openProject} onBrowse={() => void chooseProject()} />
        </section>

        <div class="mt-9 grid min-w-0 items-start gap-x-8 gap-y-9 lg:grid-cols-2">
          <section class="home-section home-section-primary min-w-0" aria-labelledby="home-recent-sessions">
            <SectionHeader
              id="home-recent-sessions"
              title={language.t("home.recentSessions")}
              action={language.t("home.recentSessions.viewAll")}
              onAction={showRecentSessions}
            />
            <Show
              when={!sessions.loading}
              fallback={
                <div class="flex min-h-36 items-center justify-center">
                  <Spinner />
                </div>
              }
            >
              <Show
                when={!sessions.error}
                fallback={
                  <button
                    type="button"
                    class="mt-3 w-full rounded-lg px-3 py-8 text-center text-12-regular text-text-danger outline-none transition-colors hover:bg-surface-base-hover active:bg-surface-base-active focus-visible:bg-surface-base-hover"
                    onClick={() => void refetchSessions()}
                  >
                    {language.t("home.section.loadError")}
                  </button>
                }
              >
                <Show
                  when={(sessions() ?? []).length > 0}
                  fallback={<div class="px-3 py-10 text-center text-12-regular text-text-weak">{language.t("home.recentSessions.empty")}</div>}
                >
                  <ul class="home-work-list divide-y divide-border-weak-base">
                    <For each={homeSessions()}>
                      {(session) => (
                        <li>
                          <button
                            type="button"
                            class="home-work-row group flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left outline-none"
                            onClick={() => openSession(session)}
                          >
                            <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-base text-icon-base">
                              <Icon name="speech-bubble" size="small" />
                            </span>
                            <span class="min-w-0 flex-1">
                              <span class="block truncate text-13-medium text-text-strong">
                                {session.title?.trim() || session.id.slice(0, 8)}
                              </span>
                              <span class="mt-0.5 block truncate text-12-regular text-text-base">
                                {latestUserMessages[session.id] ?? language.t("home.recentSessions.noUserMessage")}
                              </span>
                              <span class="mt-0.5 block truncate text-11-regular text-text-weak">
                                {session.project?.name || getFilename(session.project?.worktree ?? session.directory) || displayPath(session.directory)}
                              </span>
                            </span>
                            <span class="shrink-0 text-11-regular text-text-weaker">
                              {relativeTime(session.time.updated ?? session.time.created)}
                            </span>
                            <Icon name="arrow-right" size="small" class="shrink-0 text-icon-weak group-hover:text-icon-base" />
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </Show>
            </Show>
          </section>

          <section class="home-section min-w-0" aria-labelledby="home-upcoming-tasks">
            <SectionHeader
              id="home-upcoming-tasks"
              title={language.t("home.upcomingTasks")}
              action={language.t("home.upcomingTasks.manage")}
              onAction={() => navigate("/scheduled")}
            />
            <Show
              when={!tasks.loading}
              fallback={
                <div class="flex min-h-28 items-center justify-center">
                  <Spinner />
                </div>
              }
            >
              <Show
                when={!tasks.error}
                fallback={
                  <button
                    type="button"
                    class="mt-3 w-full rounded-lg px-3 py-7 text-center text-12-regular text-text-danger outline-none transition-colors hover:bg-surface-base-hover active:bg-surface-base-active focus-visible:bg-surface-base-hover"
                    onClick={() => void refetchTasks()}
                  >
                    {language.t("home.section.loadError")}
                  </button>
                }
              >
                <Show
                  when={(tasks() ?? []).length > 0}
                  fallback={<div class="px-3 py-8 text-center text-12-regular text-text-weak">{language.t("home.upcomingTasks.empty")}</div>}
                >
                  <ul class="home-work-list divide-y divide-border-weak-base">
                    <For each={tasks() ?? []}>
                      {(task) => (
                        <li>
                          <button
                            type="button"
                            class="home-work-row group flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left outline-none"
                            onClick={() => navigate(`/scheduled?task=${encodeURIComponent(task.id)}`)}
                          >
                            <span class={`mt-1.5 size-2 shrink-0 rounded-full ${taskTone(task)}`} aria-hidden="true" />
                            <span class="min-w-0 flex-1">
                              <span class="block truncate text-12-medium text-text-strong">{task.name}</span>
                              <span class="mt-0.5 block truncate text-11-regular text-text-weak">
                                {task.projectName || displayPath(task.directory)}
                              </span>
                            </span>
                            <span class="shrink-0 text-right text-11-regular text-text-weaker">
                              <span class="block text-text-weak">{taskStatus(task)}</span>
                              <span class="mt-0.5 block" title={new Date(task.nextRunAt!).toLocaleString(language.intl())}>
                                {relativeTime(task.nextRunAt!)}
                              </span>
                            </span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </Show>
            </Show>
          </section>
        </div>
      </main>
    </div>
  )
}
