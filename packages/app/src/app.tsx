import "@/index.css"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Icon, IconPackProvider, type IconName } from "@opencode-ai/ui/icon"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { type Duration, Effect } from "effect"
import {
  type Accessor,
  type Component,
  createMemo,
  createEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { GlobalSyncProvider } from "@/context/global-sync"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider, useLayout } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SessionHistoryProvider } from "@/context/session-history"
import { SettingsProvider, useSettings } from "@/context/settings"
import { SDKProvider } from "@/context/sdk"
import { SyncProvider } from "@/context/sync"
import { useGlobalSync } from "@/context/global-sync"
import { TerminalProvider } from "@/context/terminal"
import { SectionButton } from "@/pages/config-section-button"
import DirectoryLayout from "@/pages/directory-layout"
import Layout from "@/pages/layout"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"

const HomeRoute = lazy(() => import("@/pages/home"))
const Session = lazy(() => import("@/pages/session"))
const Config = lazy(() => {
  const started = performance.now()
  const clickAt = (window as Window & { __configNavClickAt?: number }).__configNavClickAt
  const sinceClick = typeof clickAt === "number" ? `${(started - clickAt).toFixed(1)}ms` : "n/a"
  console.info(`[config-perf] lazy import start sinceClick=${sinceClick}`)
  return import("@/pages/config").then((mod) => {
    const done = performance.now()
    const sinceClickDone = typeof clickAt === "number" ? `${(done - clickAt).toFixed(1)}ms` : "n/a"
    console.info(
      `[config-perf] lazy import done loadMs=${(done - started).toFixed(1)} sinceClick=${sinceClickDone}`,
    )
    return mod
  })
})
const Scheduled = lazy(() => import("@/pages/scheduled"))
const Loading = () => <div class="size-full" />

// Kick off config chunk prefetch once the app shell is up (idle).
if (typeof window !== "undefined") {
  void import("@/utils/prefetch-config").then((m) => m.prefetchConfigPageWhenIdle())
}

const CONFIG_FALLBACK_SECTIONS = [
  {
    id: "providers",
    key: "config.providers.title",
    descriptionKey: "config.nav.providersDescription",
    icon: "providers",
  },
  { id: "agents-md", label: "AGENTS.md", descriptionKey: "config.section.agentsMd", icon: "review" },
  { id: "agents", key: "config.agents.title", descriptionKey: "config.nav.agentsDescription", icon: "robot" },
  { id: "skills", key: "config.skills.title", descriptionKey: "config.nav.skillsDescription", icon: "book" },
  { id: "plugins", key: "config.plugins.title", descriptionKey: "config.nav.pluginsDescription", icon: "code" },
  { id: "mcp", key: "config.mcp.title", descriptionKey: "config.nav.mcpDescription", icon: "mcp" },
  {
    id: "commands",
    key: "config.commands.title",
    descriptionKey: "config.nav.commandsDescription",
    icon: "terminal",
  },
  {
    id: "channels",
    key: "config.channels.title",
    descriptionKey: "config.nav.channelsDescription",
    icon: "speech-bubble",
  },
  { id: "claws", key: "config.claws.title", descriptionKey: "config.nav.clawsDescription", icon: "openclaw" },
] as const satisfies ReadonlyArray<{
  id: string
  icon: IconName
  label?: string
  key?: string
  descriptionKey: string
}>

function configPerfSinceClick() {
  const clickAt = (window as Window & { __configNavClickAt?: number }).__configNavClickAt
  if (typeof clickAt !== "number") return "n/a"
  return `${(performance.now() - clickAt).toFixed(1)}ms`
}

function ConfigRouteFrame(props: ParentProps) {
  const platform = usePlatform()
  const layout = useLayout()

  createEffect(() => {
    console.info(
      `[config-perf] route-frame effect pathname=${window.location.pathname} sinceClick=${configPerfSinceClick()}`,
    )
  })

  onMount(() => {
    console.info(`[config-perf] route-frame mount sinceClick=${configPerfSinceClick()}`)
    if (platform.platform !== "desktop") return
    queueMicrotask(() => {
      if (!layout.sidebar.opened()) return
      layout.sidebar.close()
    })
  })

  return <>{props.children}</>
}

// Skeleton shell shown while Config page lazy-loads.
// MUST stay in sync with pages/config.tsx sidebar and middle column styles
// (font sizes, titles, descriptions) to avoid a visual flash on first render.
function ConfigLoadingShell() {
  const language = useLanguage()
  const platform = usePlatform()
  const showClawsSection = () => platform.platform === "desktop"

  onMount(() => {
    console.info(`[config-perf] loading-shell mount sinceClick=${configPerfSinceClick()}`)
  })

  return (
    <div class="size-full overflow-hidden bg-background-base">
      <div class="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_5%_0%,color-mix(in_srgb,var(--surface-brand-base)_7%,transparent),transparent_32%),linear-gradient(135deg,color-mix(in_srgb,var(--surface-brand-base)_3%,var(--background-base)),var(--background-base)_45%)] xl:flex-row">
        <aside class="shrink-0 border-b border-border-weak-base bg-[linear-gradient(165deg,color-mix(in_srgb,var(--surface-brand-base)_7%,var(--surface-base)),color-mix(in_srgb,var(--surface-brand-base)_3%,var(--background-base))_46%,var(--background-base))] xl:w-[236px] xl:border-r xl:border-b-0">
          <div class="flex h-full min-h-0 flex-col">
            <div class="relative flex items-center gap-3 border-b border-border-weak-base px-4 py-5">
              <div
                class="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-weak-base bg-background-base/75 text-text-weak shadow-sm"
                aria-hidden="true"
              >
                <Icon name="chevron-left" size="small" />
              </div>
              <div class="min-w-0 text-20-medium text-text-strong">{language.t("config.title")}</div>
            </div>
            <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
              <div class="flex flex-col gap-1">
                <For each={CONFIG_FALLBACK_SECTIONS.slice(0, 7)}>
                  {(section) => (
                    <SectionButton
                      current={false}
                      title={"key" in section ? language.t(section.key) : section.label}
                      description={language.t(section.descriptionKey)}
                      icon={section.icon}
                    />
                  )}
                </For>
              </div>
              <div class="mx-2 my-3 h-px bg-[linear-gradient(90deg,var(--border-weak-base),transparent)]" />
              <div class="flex flex-col gap-1">
                <For each={CONFIG_FALLBACK_SECTIONS.slice(7)}>
                  {(section) => (
                    <Show when={section.id !== "claws" || showClawsSection()}>
                      <SectionButton
                        current={false}
                        title={"key" in section ? language.t(section.key) : section.label}
                        description={language.t(section.descriptionKey)}
                        icon={section.icon}
                      />
                    </Show>
                  )}
                </For>
              </div>
            </div>
          </div>
        </aside>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col xl:flex-row">
          <section class="shrink-0 border-b border-border-weak-base bg-[color-mix(in_srgb,var(--surface-brand-base)_3%,var(--surface-base))] backdrop-blur xl:w-[400px] xl:border-r xl:border-b-0">
            <div class="relative overflow-hidden bg-[linear-gradient(135deg,color-mix(in_srgb,var(--surface-brand-base)_8%,var(--background-base)),color-mix(in_srgb,var(--surface-brand-base)_3%,var(--background-base)))] px-5 py-5">
              <div class="flex items-start gap-3">
                <div class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border-weak-base bg-background-base text-text-weak">
                  <Icon name="providers" size="medium" />
                </div>
                <div class="min-w-0 pt-0.5">
                  <div class="text-18-medium text-text-strong">{language.t("config.providers.title")}</div>
                  <div class="mt-1 text-12-regular text-text-weak">{language.t("config.providers.header")}</div>
                </div>
              </div>
            </div>
          </section>
          <main class="min-h-0 min-w-0 flex-1 bg-[linear-gradient(155deg,color-mix(in_srgb,var(--surface-brand-base)_2%,var(--background-base)),var(--background-base)_38%)]" />
        </div>
      </div>
    </div>
  )
}

const SessionRoute = () => (
  <SessionProviders>
    <Session />
  </SessionProviders>
)

const SessionIndexRoute = () => <Navigate href="session" />

const ConfigRoute = () => (
  <ConfigRouteFrame>
    <ErrorBoundary
      fallback={(error, reset) => {
        // 捕获 context 相关错误，提供重试机制
        if (error.message?.includes("GlobalSyncProvider")) {
          return (
            <div class="flex size-full items-center justify-center">
              <div class="flex flex-col items-center gap-4">
                <div class="text-sm text-muted-foreground">配置页面加载失败</div>
                <button
                  class="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
                  onClick={() => reset()}
                >
                  重试
                </button>
              </div>
            </div>
          )
        }
        return <ErrorPage error={error} />
      }}
    >
      <Suspense fallback={<ConfigLoadingShell />}>
        <Config />
      </Suspense>
    </ErrorBoundary>
  </ConfigRouteFrame>
)

function GlobalConfigRoute() {
  const globalSync = useGlobalSync()
  const directory = createMemo(() => globalSync.data.path.directory || globalSync.data.path.home)

  createEffect(() => {
    console.info(
      `[config-perf] global-config-route directory=${directory() || "none"} ready=${String(globalSync.data.ready)} providerAll=${String(globalSync.data.provider.all.length)} sinceClick=${configPerfSinceClick()}`,
    )
  })

  return (
    <Show when={directory()} keyed fallback={<ConfigLoadingShell />}>
      {(directory) => (
        <SDKProvider directory={() => directory}>
          <SyncProvider>
            <ConfigRoute />
          </SyncProvider>
        </SDKProvider>
      )}
    </Show>
  )
}

function CrashProbe() {
  const [armed, setArmed] = createSignal(false)

  onMount(() => {
    if (!import.meta.env.DEV) return
    if (!new URLSearchParams(location.search).has("force_error")) return
    requestAnimationFrame(() => setArmed(true))
  })

  if (armed()) throw new Error("Forced error page")
  return null
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      updaterEnabled?: boolean
      serverPassword?: string
      deepLinks?: string[]
      initialPath?: string | null
      wsl?: boolean
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
    }
  }
}

function MarkedProviderWithNativeParser(props: ParentProps) {
  const platform = usePlatform()
  return (
    <MarkedProvider
      nativeParser={platform.platform === "desktop" ? platform.parseMarkdown : undefined}
      mathOutput={platform.platform === "desktop" ? "html" : "htmlAndMathml"}
    >
      {props.children}
    </MarkedProvider>
  )
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient()
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function IconPackFromSettings(props: ParentProps) {
  const settings = useSettings()
  return <IconPackProvider pack={settings.appearance.iconPack()}>{props.children}</IconPackProvider>
}

function AppShellProviders(props: ParentProps) {
  return (
    <SettingsProvider>
      <IconPackFromSettings>
        <PermissionProvider>
          <SessionHistoryProvider>
            <LayoutProvider>
              <NotificationProvider>
                <ModelsProvider>
                  <CommandProvider>
                    <HighlightsProvider>
                      <Layout>{props.children}</Layout>
                    </HighlightsProvider>
                  </CommandProvider>
                </ModelsProvider>
              </NotificationProvider>
            </LayoutProvider>
          </SessionHistoryProvider>
        </PermissionProvider>
      </IconPackFromSettings>
    </SettingsProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function RouterRoot(props: ParentProps<{ appChildren?: JSX.Element }>) {
  return (
    <AppShellProviders>
      <Suspense fallback={<Loading />}>
        {props.appChildren}
        {props.children}
      </Suspense>
    </AppShellProviders>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <CrashProbe />
              <QueryProvider>
                <DialogProvider>
                  <MarkedProviderWithNativeParser>
                    <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                  </MarkedProviderWithNativeParser>
                </DialogProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

const effectMinDuration =
  (duration: Duration.Input) =>
  <A, E, R>(e: Effect.Effect<A, E, R>) =>
    Effect.all([e, Effect.sleep(duration)], { concurrency: "unbounded" }).pipe(Effect.map((v) => v[0]))

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean | Accessor<boolean> }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()
  const [store, setStore] = createStore({
    message: "",
  })
  let sent = false
  const disabled = () =>
    typeof props.disableHealthCheck === "function" ? props.disableHealthCheck() : props.disableHealthCheck

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    disabled()
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            setStore("message", res.message ?? "")
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          effectMinDuration(checkMode() === "blocking" ? "1.2 seconds" : 0),
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )

  createEffect(() => {
    if (sent) return
    if (startupHealthCheck.loading) return
    if (!startupHealthCheck()) return
    sent = true
    queueMicrotask(() => window.dispatchEvent(new CustomEvent("opencode:startup-ready")))
  })

  return (
    <Show
      when={checkMode() === "blocking" ? !startupHealthCheck.loading : startupHealthCheck.state !== "pending"}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show
        when={startupHealthCheck()}
        fallback={
          <ConnectionError
            message={() => store.message}
            onRetry={() => {
              if (checkMode() === "background") healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

function ConnectionError(props: {
  message?: Accessor<string>
  onRetry?: () => void
  onServerSelected?: (key: ServerConnection.Key) => void
}) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
        <Show when={props.message?.()}>
          <p class="mt-2 text-12-regular text-text-danger break-words">{props.message?.()}</p>
        </Show>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerScopedApp(
  props: ParentProps<{ disableHealthCheck?: boolean | Accessor<boolean>; router?: Component<BaseRouterProps> }>,
) {
  const server = useServer()
  return (
    <Show when={server.current}>
      <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
        <GlobalSDKProvider>
          <GlobalSyncProvider>
            <Dynamic
              component={props.router ?? Router}
              root={(routerProps) => <RouterRoot appChildren={props.children}>{routerProps.children}</RouterRoot>}
            >
              <Route path="/" component={HomeRoute} />
              <Route path="/scheduled" component={Scheduled} />
              <Route path="/config" component={GlobalConfigRoute} />
              <Route path="/:dir" component={DirectoryLayout}>
                <Route path="/" component={SessionIndexRoute} />
                <Route path="/session/:id?" component={SessionRoute} />
                <Route path="/scheduled" component={Scheduled} />
                <Route path="/config" component={ConfigRoute} />
              </Route>
            </Dynamic>
          </GlobalSyncProvider>
        </GlobalSDKProvider>
      </ConnectionGate>
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean | Accessor<boolean>
}) {
  return (
    <ServerProvider defaultServer={props.defaultServer} servers={props.servers}>
      <ServerScopedApp disableHealthCheck={props.disableHealthCheck} router={props.router}>
        {props.children}
      </ServerScopedApp>
    </ServerProvider>
  )
}
