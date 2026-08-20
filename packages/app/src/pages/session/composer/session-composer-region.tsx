import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { PromptInput } from "@/components/prompt-input"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { domainFromDirectory } from "@/pages/layout/extra-agents"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { useSessionKey } from "@/pages/session/session-layout"
import { listBackgroundShells, type BackgroundShellInfo } from "@/pages/session/background-shell-api"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionSkippedQuestionsDialog } from "@/pages/session/composer/session-skipped-questions-dialog"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import type { SessionComposerState } from "@/pages/session/composer/session-composer-state"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import type { SessionChildAgentEntry } from "@/pages/session/session-child-agents"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"

function ComposerDockExit(props: {
  active: boolean
  children: JSX.Element
  /** When false, snap open/closed without spring (e.g. first paint of prompt). Default true. */
  animate?: boolean
  onVisibleChange?: (visible: boolean) => void
}) {
  // Fade + height motion with bottom-aligned content:
  // exit shrinks downward (top edge moves down); enter expands upward (top edge moves up).
  const [store, setStore] = createStore({
    height: 0,
    body: undefined as HTMLDivElement | undefined,
  })
  const progress = useSpring(() => (props.active ? 1 : 0), { visualDuration: 0.28, bounce: 0 })
  const animated = createMemo(() => props.animate !== false)
  const value = createMemo(() => {
    if (!animated()) return props.active ? 1 : 0
    return Math.max(0, Math.min(1, progress()))
  })
  const visible = createMemo(() => props.active || value() > 0.001)
  const settledOpen = createMemo(() => props.active && value() > 0.98)
  const maxHeight = createMemo(() => {
    // Settled open: let content grow freely (multiline prompt, toolbars, etc.)
    if (settledOpen()) return "none"
    if (store.height <= 0) return animated() ? "0px" : props.active ? "none" : "0px"
    return `${Math.max(0, store.height * value())}px`
  })

  const measure = (el: HTMLElement) => {
    const next = Math.max(el.scrollHeight, el.getBoundingClientRect().height)
    if (next > 0) setStore("height", next)
  }

  createEffect(() => {
    props.onVisibleChange?.(visible())
  })

  createEffect(() => {
    const el = store.body
    if (!el) return
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        measure(el)
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    onCleanup(() => {
      observer.disconnect()
      if (raf === undefined) return
      cancelAnimationFrame(raf)
    })
  })

  return (
    <Show when={visible()}>
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          "justify-content": "flex-end",
          overflow: settledOpen() ? "visible" : "hidden",
          "max-height": maxHeight(),
          opacity: `${value()}`,
          "pointer-events": props.active ? "auto" : "none",
        }}
      >
        <div
          ref={(el) => {
            setStore("body", el)
            measure(el)
          }}
        >
          {props.children}
        </div>
      </div>
    </Show>
  )
}

function formatChildAgentTime(value: number, locale: string): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

type BackgroundShellEventName = "background.shell.created" | "background.shell.updated" | "background.shell.exited"

type BackgroundShellEventSource = {
  on(type: BackgroundShellEventName, handler: () => void): VoidFunction
}

function isBackgroundShellEventSource(value: unknown): value is BackgroundShellEventSource {
  return typeof value === "object" && value !== null && "on" in value && typeof value.on === "function"
}

function backgroundShellStatusClass(value: string): string {
  if (value === "completed") return "text-icon-success-base"
  if (value === "running") return "text-icon-warning-base"
  if (value === "stopped") return "text-text-weak"
  return "text-icon-critical-base"
}

function SessionBackgroundShellMenu(props: {
  entries: BackgroundShellInfo[]
  loading: boolean
  onRefresh: () => void
  onOpen: (entry: BackgroundShellInfo) => void
}) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)

  createEffect(() => {
    if (open()) props.onRefresh()
  })

  return (
    <DropdownMenu open={open()} onOpenChange={setOpen} gutter={6} placement="top-start">
      <DropdownMenu.Trigger
        as={Button}
        variant="ghost"
        size="small"
        icon="console"
        class="h-7 rounded-md px-2 text-text-weak hover:text-text-strong data-[expanded]:bg-surface-base-active"
        aria-label="查看背景shell"
        data-testid="session-background-shell-menu-trigger"
      >
        <span>查看背景shell</span>
        <Show when={props.entries.length > 0}>
          <span class="text-11-medium text-text-weak">({props.entries.length})</span>
        </Show>
        <Icon name="chevron-down" size="small" class="text-icon-weak" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class="session-child-agent-scrollbar w-[420px] max-w-[calc(100vw-32px)]"
          style={{
            "max-height": "min(520px, calc(100dvh - 160px))",
            "overflow-y": "auto",
            "overscroll-behavior": "contain",
            "scrollbar-gutter": "stable",
          }}
        >
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
              背景 shell
            </DropdownMenu.GroupLabel>
            <Show
              when={props.entries.length > 0}
              fallback={
                <DropdownMenu.Item disabled>
                  <DropdownMenu.ItemLabel class="text-13-regular text-text-weak">
                    {props.loading ? language.t("prompt.loading") : "本会话暂无背景 shell"}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              }
            >
              <For each={props.entries}>
                {(entry) => {
                  const time = () => formatChildAgentTime(entry.endedAt ?? entry.startedAt, language.intl())
                  const status = () =>
                    entry.status === "error" && typeof entry.exitCode === "number"
                      ? `error ${entry.exitCode}`
                      : entry.status

                  return (
                    <DropdownMenu.Item
                      class="min-w-0"
                      onSelect={() => props.onOpen(entry)}
                      data-testid="session-background-shell-menu-item"
                    >
                      <div class="min-w-0 flex flex-col gap-1">
                        <DropdownMenu.ItemLabel class="truncate text-13-medium text-text-strong">
                          {entry.description || entry.command}
                        </DropdownMenu.ItemLabel>
                        <DropdownMenu.ItemDescription class="truncate text-11-regular text-text-weak">
                          <span class={`font-medium ${backgroundShellStatusClass(entry.status)}`}>{status()}</span>
                          <span> - </span>
                          <span>{time()}</span>
                          <span> - </span>
                          <span>{entry.id}</span>
                        </DropdownMenu.ItemDescription>
                        <div class="truncate font-mono text-11-regular text-text-weak">{entry.command}</div>
                      </div>
                    </DropdownMenu.Item>
                  )
                }}
              </For>
            </Show>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

type SessionUserMessageEntry = {
  id: string
  text: string
  created: number
}

function SessionUserMessageMenu(props: {
  entries: SessionUserMessageEntry[]
  onOpen: (entry: SessionUserMessageEntry) => void
}) {
  const language = useLanguage()

  return (
    <DropdownMenu gutter={6} placement="top-start">
      <DropdownMenu.Trigger
        as={Button}
        variant="ghost"
        size="small"
        icon="speech-bubble"
        class="h-7 rounded-md px-2 text-text-weak hover:text-text-strong data-[expanded]:bg-surface-base-active"
        aria-label="查看用户消息"
        data-testid="session-user-message-menu-trigger"
      >
        <span>查看用户消息</span>
        <span class="text-11-medium text-text-weak">({props.entries.length})</span>
        <Icon name="chevron-down" size="small" class="text-icon-weak" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          class="session-child-agent-scrollbar w-[420px] max-w-[calc(100vw-32px)]"
          style={{
            "max-height": "min(520px, calc(100dvh - 160px))",
            "overflow-y": "auto",
            "overscroll-behavior": "contain",
            "scrollbar-gutter": "stable",
          }}
        >
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
              用户消息
            </DropdownMenu.GroupLabel>
            <For each={props.entries}>
              {(entry, index) => (
                <DropdownMenu.Item
                  class="min-w-0"
                  onSelect={() => props.onOpen(entry)}
                  data-testid="session-user-message-menu-item"
                >
                  <div class="min-w-0 flex flex-col gap-1">
                    <DropdownMenu.ItemLabel class="truncate text-13-medium text-text-strong">
                      {entry.text}
                    </DropdownMenu.ItemLabel>
                    <DropdownMenu.ItemDescription class="text-11-regular text-text-weak">
                      <span>第 {index() + 1} 条</span>
                      <span> - </span>
                      <span>{formatChildAgentTime(entry.created, language.intl())}</span>
                    </DropdownMenu.ItemDescription>
                  </div>
                </DropdownMenu.Item>
              )}
            </For>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

function SessionBackgroundShellDialog(props: {
  entry: BackgroundShellInfo
  load: (id: string) => Promise<BackgroundShellInfo>
}) {
  const [current, setCurrent] = createSignal(props.entry)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>()
  let request = 0

  const currentID = createMemo(() => current().id)
  const currentStatus = createMemo(() => current().status)
  const title = createMemo(() => current().description || current().command)
  const output = createMemo(() => current().outputTail || "(no output)")
  const status = createMemo(() => {
    const entry = current()
    if (entry.status === "error" && typeof entry.exitCode === "number") return `error ${entry.exitCode}`
    return entry.status
  })

  const refresh = async (quiet = false, id = currentID()) => {
    const active = ++request
    if (!quiet) setLoading(true)
    setError(undefined)
    try {
      const next = await props.load(id)
      if (active === request) setCurrent(next)
    } catch (e) {
      if (active !== request) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (active === request) setLoading(false)
    }
  }

  onMount(() => {
    void refresh()
  })

  createEffect(() => {
    const id = currentID()
    if (currentStatus() !== "running") return
    const timer = window.setInterval(() => {
      void refresh(true, id)
    }, 2_000)
    onCleanup(() => window.clearInterval(timer))
  })

  return (
    <Dialog title="背景 shell 输出" size="large" class="max-h-[min(720px,calc(100dvh-64px))]">
      <div class="flex min-h-0 flex-col gap-3 px-4 pb-4">
        <div class="rounded-lg border border-border-weak-base bg-surface-raised-base px-3 py-2">
          <div class="flex min-w-0 items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate text-13-medium text-text-strong">{title()}</div>
              <div class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-11-regular text-text-weak">
                <span class={`font-medium ${backgroundShellStatusClass(currentStatus())}`}>{status()}</span>
                <span>{current().id}</span>
                <span class="truncate">{current().cwd}</span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="small"
              class="h-7 shrink-0 rounded-md px-2"
              disabled={loading()}
              onClick={() => void refresh()}
            >
              {loading() ? "刷新中" : "刷新"}
            </Button>
          </div>
          <div class="mt-2 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-11-regular text-text-weak">
            {current().command}
          </div>
        </div>

        <Show when={error()}>
          {(message) => (
            <div class="rounded-md border border-border-critical-base bg-surface-critical-base px-3 py-2 text-12-regular text-text-strong">
              {message()}
            </div>
          )}
        </Show>

        <pre
          class="max-h-[52dvh] min-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-weak-base bg-background-base p-3 font-mono text-12-regular leading-5 text-text-base"
          data-testid="session-background-shell-output"
        >
          {output()}
        </pre>
      </div>
    </Dialog>
  )
}

function SessionChildAgentMenu(props: {
  entries: SessionChildAgentEntry[]
  onOpen: (entry: SessionChildAgentEntry) => void
}) {
  const language = useLanguage()
  let contentRef: HTMLDivElement | undefined
  let scrollTimer: number | undefined
  const [scrolling, setScrolling] = createSignal(false)
  const indexBadge = (entry: SessionChildAgentEntry): string | undefined => {
    if (entry.index === undefined) return undefined
    if (entry.resume) {
      return language.t("session.childAgents.indexResume", { index: entry.index })
    }
    return language.t("session.childAgents.index", { index: entry.index })
  }
  const title = (entry: SessionChildAgentEntry): string => {
    const cleaned = entry.title.replace(/\s+\(@[^)]*\s+subagent\)$/i, "").trim()
    return cleaned || entry.title
  }
  const agent = (entry: SessionChildAgentEntry): string | undefined => {
    const value = entry.agent
      ?.replace(/^@/, "")
      .split(/\s+-\s+/)[0]
      ?.trim()
    return value ? `@${value}` : undefined
  }
  const status = (entry: SessionChildAgentEntry): string | undefined => entry.usage ?? entry.status
  const statusClass = (value: string): string => {
    if (value === "completed") return "text-icon-success-base"
    if (value === "not used") return "text-icon-warning-base"
    if (value === "running") return "text-icon-warning-base"
    return "text-icon-critical-base"
  }
  const backgroundLabel = (): string => language.t("session.childAgents.background")
  const revealScrollbar = (): void => {
    if (scrollTimer !== undefined) {
      window.clearTimeout(scrollTimer)
      scrollTimer = undefined
    }
    setScrolling(true)
    scrollTimer = window.setTimeout(() => {
      setScrolling(false)
      scrollTimer = undefined
    }, 900)
  }
  const scrollHighlightedIntoView = (): void => {
    const content = contentRef
    if (!content) return
    revealScrollbar()
    requestAnimationFrame(() => {
      const highlighted = content.querySelector<HTMLElement>('[data-slot="dropdown-menu-item"][data-highlighted]')
      highlighted?.scrollIntoView({ block: "nearest" })
    })
  }
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) return
    scrollHighlightedIntoView()
  }
  const handleScroll = (): void => {
    revealScrollbar()
  }

  onCleanup(() => {
    if (scrollTimer === undefined) return
    window.clearTimeout(scrollTimer)
  })

  return (
    <Show when={props.entries.length > 0}>
      <DropdownMenu gutter={6} placement="top-start">
        <DropdownMenu.Trigger
          as={Button}
          variant="ghost"
          size="small"
          icon="branch"
          class="h-7 rounded-md px-2 text-text-weak hover:text-text-strong data-[expanded]:bg-surface-base-active"
          aria-label={language.t("session.childAgents.open")}
          data-testid="session-child-agent-menu-trigger"
        >
          <span>{language.t("session.childAgents.button", { count: props.entries.length })}</span>
          <Icon name="chevron-down" size="small" class="text-icon-weak" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            ref={(el: HTMLDivElement) => {
              contentRef = el
            }}
            class="session-child-agent-scrollbar w-[340px] max-w-[calc(100vw-32px)]"
            data-scrolling={scrolling() ? "true" : undefined}
            style={{
              "max-height": "min(520px, calc(100dvh - 160px))",
              "overflow-y": "auto",
              "overscroll-behavior": "contain",
              "scrollbar-gutter": "stable",
            }}
            onKeyDown={handleKeyDown}
            onScroll={handleScroll}
          >
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel class="text-11-medium uppercase tracking-[0.08em] text-text-weak">
                {language.t("session.childAgents.menuLabel")}
              </DropdownMenu.GroupLabel>
              <For each={props.entries}>
                {(entry) => {
                  const itemIndexBadge = () => indexBadge(entry)
                  const itemAgent = () => agent(entry)
                  const itemStatus = () => status(entry)
                  const itemTime = () => formatChildAgentTime(entry.created, language.intl())
                  const itemBackground = () => entry.background === true

                  return (
                    <DropdownMenu.Item
                      class="min-w-0"
                      onSelect={() => props.onOpen(entry)}
                      data-testid="session-child-agent-menu-item"
                      data-background={itemBackground() ? "true" : undefined}
                    >
                      <div class="min-w-0 flex flex-col gap-0.5">
                        <DropdownMenu.ItemLabel class="flex min-w-0 items-center gap-1.5 text-13-medium text-text-strong">
                          <Show when={itemIndexBadge()}>
                            {(mark) => (
                              <span
                                class={
                                  entry.resume
                                    ? "shrink-0 font-semibold text-text-warning-base"
                                    : "shrink-0 font-semibold text-text-info-base"
                                }
                              >
                                {mark()}
                              </span>
                            )}
                          </Show>
                          <span class="min-w-0 truncate">{title(entry)}</span>
                          <Show when={itemBackground()}>
                            <span
                              class="inline-flex shrink-0 items-center rounded-full border border-border-weak-base bg-surface-base px-2 py-0.5 text-11-medium font-medium text-text-info-base"
                              data-testid="session-child-agent-background-badge"
                            >
                              {backgroundLabel()}
                            </span>
                          </Show>
                          <Show when={itemStatus()}>
                            {(value) => (
                              <span
                                class={`shrink-0 text-11-medium font-medium ${statusClass(value())}`}
                                data-testid="session-child-agent-status"
                              >
                                {value()}
                              </span>
                            )}
                          </Show>
                        </DropdownMenu.ItemLabel>
                        <Show when={itemAgent() || itemTime()}>
                          <DropdownMenu.ItemDescription class="truncate text-11-regular text-text-weak">
                            <Show when={itemAgent()}>{(value) => <span>{value()}</span>}</Show>
                            <Show when={itemTime()}>
                              {(time) => (
                                <>
                                  <Show when={itemAgent()}>
                                    <span> - </span>
                                  </Show>
                                  <span>{time()}</span>
                                </>
                              )}
                            </Show>
                          </DropdownMenu.ItemDescription>
                        </Show>
                      </div>
                    </DropdownMenu.Item>
                  )
                }}
              </For>
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}

export function SessionComposerRegion(props: {
  state: SessionComposerState
  ready: boolean
  centered: boolean
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onSubmitted?: () => void
  onResponseSubmit: () => void
  onScrollToBottom: () => void
  scrollState?: { overflow: boolean; bottom: boolean }
  followup?: {
    queue: () => boolean
    items: { id: string; text: string }[]
    sending?: string
    edit?: { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] }
    onQueue: (draft: FollowupDraft) => void
    onAbort: () => void
    onSend: (id: string) => void
    onEdit: (id: string) => void
    onEditLoaded: () => void
  }
  revert?: {
    items: { id: string; text: string }[]
    restoring?: string
    disabled?: boolean
    onRestore: (id: string) => void
  }
  childAgents?: SessionChildAgentEntry[]
  onOpenChildAgent?: (entry: SessionChildAgentEntry) => void
  userMessages?: SessionUserMessageEntry[]
  onOpenUserMessage?: (entry: SessionUserMessageEntry) => void
  subagentNavigation?: {
    parentID: string
    previous?: string
    next?: string
    earlierCount: number
    laterCount: number
    onNavigate: (sessionID: string) => void
  }
  subagentTitle?: string
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  const prompt = usePrompt()
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useSDK()
  const platform = usePlatform()
  const server = useServer()
  const route = useSessionKey()

  const handoffPrompt = createMemo(() => getSessionHandoff(route.sessionKey())?.prompt)

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(route.sessionKey(), { prompt: previewPrompt() })
  })

  const [store, setStore] = createStore({
    ready: false,
    height: 320,
    body: undefined as HTMLDivElement | undefined,
  })
  const [heldQuestion, setHeldQuestion] = createSignal<QuestionRequest | undefined>()
  const [heldPermission, setHeldPermission] = createSignal<PermissionRequest | undefined>()
  // Keep prompt hidden while dock exit fade is still on screen
  const [exitVisible, setExitVisible] = createStore({ question: false, permission: false })
  const [backgroundShells, setBackgroundShells] = createSignal<BackgroundShellInfo[]>([])
  const [backgroundShellsLoading, setBackgroundShellsLoading] = createSignal(false)
  let timer: number | undefined
  let frame: number | undefined
  let backgroundRequest = 0

  createEffect(() => {
    const next = props.state.questionRequest()
    if (next) setHeldQuestion(() => next)
  })

  createEffect(() => {
    const next = props.state.permissionRequest()
    if (next) setHeldPermission(() => next)
  })

  const promptCovered = createMemo(
    () => props.state.blocked() || exitVisible.question || exitVisible.permission,
  )
  // Only animate prompt enter/exit after it has been covered once (avoid first-paint flash)
  const [promptWasCovered, setPromptWasCovered] = createSignal(false)
  createEffect(() => {
    if (promptCovered()) setPromptWasCovered(true)
  })

  const clear = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      frame = undefined
    }
  }

  createEffect(() => {
    route.sessionKey()
    const ready = props.ready
    const delay = 140

    clear()
    setStore("ready", false)
    if (!ready) return

    frame = requestAnimationFrame(() => {
      frame = undefined
      timer = window.setTimeout(() => {
        setStore("ready", true)
        timer = undefined
      }, delay)
    })
  })

  onCleanup(clear)

  // Desktop uses the floating todo widget instead of the bottom dock,
  // so the dock animation/margins should not run on desktop.
  const open = createMemo(() => store.ready && props.state.dock() && !props.state.closing() && platform.platform !== "desktop")
  const progress = useSpring(() => (open() ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const dock = createMemo(() => (store.ready && props.state.dock()) || value() > 0.001)
  const rolled = createMemo(() => (props.revert?.items.length ? props.revert : undefined))
  const lift = createMemo(() => (rolled() ? 18 : 36 * value()))
  const full = createMemo(() => Math.max(78, store.height))
  const skippedQuestionCount = createMemo(() => props.state.skippedQuestionRequests().length)
  const childAgentMenu = createMemo(() => {
    const onOpen = props.onOpenChildAgent
    if (!onOpen) return undefined
    return { entries: props.childAgents ?? [], onOpen }
  })
  const userMessageMenu = createMemo(() => {
    if (platform.platform !== "desktop") return undefined
    const onOpen = props.onOpenUserMessage
    const entries = props.userMessages ?? []
    if (!onOpen || entries.length === 0) return undefined
    return { entries, onOpen }
  })
  const visibleSubagentNavigation = createMemo(() => {
    if (platform.platform !== "desktop") return undefined
    return props.subagentNavigation
  })
  const jumpToLatestVisible = createMemo(
    () => !!props.onScrollToBottom && !!props.scrollState?.overflow && !props.scrollState.bottom,
  )
  const showPromptToolbar = createMemo(
    () =>
      !!props.subagentTitle ||
      (childAgentMenu()?.entries.length ?? 0) > 0 ||
      (platform.platform === "desktop" && backgroundShells().length > 0) ||
      !!userMessageMenu() ||
      !!visibleSubagentNavigation() ||
      skippedQuestionCount() > 0 ||
      jumpToLatestVisible(),
  )

  createEffect(() => {
    console.debug("[composer-scroll-to-latest] state", {
      visible: jumpToLatestVisible(),
      hasHandler: !!props.onScrollToBottom,
      overflow: !!props.scrollState?.overflow,
      atBottom: !!props.scrollState?.bottom,
    })
  })

  const refreshBackgroundShells = () => {
    const sessionID = route.params.id
    if (!sessionID) {
      setBackgroundShells([])
      return
    }
    const request = ++backgroundRequest
    setBackgroundShellsLoading(true)
    void listBackgroundShells({
      sdk,
      platform,
      auth: server.currentFor(domainFromDirectory(sdk.directory))?.http,
      sessionID,
    })
      .then((items) => {
        if (request !== backgroundRequest) return
        setBackgroundShells(items)
      })
      .catch(() => {
        if (request !== backgroundRequest) return
        setBackgroundShells([])
      })
      .finally(() => {
        if (request === backgroundRequest) setBackgroundShellsLoading(false)
      })
  }

  const loadBackgroundShell = async (id: string) => {
    const sessionID = route.params.id
    if (!sessionID) throw new Error("Background shell session is not available")
    const items = await listBackgroundShells({
      sdk,
      platform,
      auth: server.currentFor(domainFromDirectory(sdk.directory))?.http,
      sessionID,
    })
    const info = items.find((item) => item.id === id)
    if (!info) throw new Error("Background shell not found")
    setBackgroundShells(items)
    return info
  }

  const openBackgroundShell = (entry: BackgroundShellInfo) => {
    dialog.show(() => <SessionBackgroundShellDialog entry={entry} load={loadBackgroundShell} />)
  }

  createEffect(() => {
    route.params.id
    sdk.directory
    setBackgroundShells([])
    refreshBackgroundShells()
  })

  createEffect(() => {
    const handler = () => refreshBackgroundShells()
    const event = sdk.event
    if (!isBackgroundShellEventSource(event)) return
    const offCreated = event.on("background.shell.created", handler)
    const offUpdated = event.on("background.shell.updated", handler)
    const offExited = event.on("background.shell.exited", handler)
    onCleanup(() => {
      offCreated?.()
      offUpdated?.()
      offExited?.()
    })
  })

  const openSkippedQuestions = () => {
    dialog.show(() => (
      <SessionSkippedQuestionsDialog
        requests={props.state.skippedQuestionRequests}
        invalidation={props.state.skippedQuestionInvalidation}
        sessionEnded={props.state.skippedQuestionSessionEnded}
        onClear={props.state.clearSkippedQuestions}
      />
    ))
  }

  createEffect(() => {
    const el = store.body
    if (!el) return
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        setStore("height", el.getBoundingClientRect().height)
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    onCleanup(() => {
      observer.disconnect()
      if (raf === undefined) return
      cancelAnimationFrame(raf)
    })
  })

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      class="shrink-0 w-full pb-3 flex flex-col justify-center items-center bg-background-stronger pointer-events-none"
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "md:max-w-[var(--session-content-width)] md:mx-auto": props.centered,
        }}
      >
        <ComposerDockExit
          active={!!props.state.questionRequest()}
          onVisibleChange={(visible) => setExitVisible("question", visible)}
        >
          <Show when={heldQuestion()} keyed>
            {(request) => <SessionQuestionDock request={request} onSubmit={props.onResponseSubmit} />}
          </Show>
        </ComposerDockExit>

        <ComposerDockExit
          active={!!props.state.permissionRequest()}
          onVisibleChange={(visible) => setExitVisible("permission", visible)}
        >
          <Show when={heldPermission()} keyed>
            {(request) => (
              <SessionPermissionDock
                request={request}
                responding={props.state.permissionResponding()}
                onDecide={(response) => {
                  props.onResponseSubmit()
                  props.state.decide(response)
                }}
              />
            )}
          </Show>
        </ComposerDockExit>

        <ComposerDockExit active={!promptCovered()} animate={promptWasCovered()}>
          <Show
            when={prompt.ready()}
            fallback={
              <>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <div class="pb-2">
                      <SessionRevertDock
                        items={revert.items}
                        restoring={revert.restoring}
                        disabled={revert.disabled}
                        onRestore={revert.onRestore}
                      />
                    </div>
                  )}
                </Show>
                <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
                  {handoffPrompt() || language.t("prompt.loading")}
                </div>
              </>
            }
          >
            <Show when={showPromptToolbar()}>
              <div
                classList={{
                  "relative mb-2 min-h-7 items-center gap-2": true,
                  "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]": !!visibleSubagentNavigation(),
                  flex: !visibleSubagentNavigation(),
                }}
              >
                <Show when={jumpToLatestVisible()}>
                  <div data-component="composer-scroll-to-latest" class="absolute left-1/2 bottom-full mb-3 -translate-x-1/2 z-20">
                    <Tooltip placement="top" value={language.t("session.messages.jumpToLatest")}>
                      <IconButton
                        type="button"
                        icon="arrow-down-to-line"
                        variant="primary"
                        size="normal"
                        iconSize="medium"
                        class="size-10 rounded-full shadow-md opacity-70 hover:opacity-100 transition-opacity [&_svg_path]:stroke-[2px]"
                        onClick={() => {
                          console.debug("[composer-scroll-to-latest] click", {
                            visible: jumpToLatestVisible(),
                            overflow: !!props.scrollState?.overflow,
                            atBottom: !!props.scrollState?.bottom,
                          })
                          props.onScrollToBottom()
                        }}
                        aria-label={language.t("session.messages.jumpToLatest")}
                      />
                    </Tooltip>
                  </div>
                </Show>
                <div
                  classList={{
                    "min-w-0 flex items-center gap-2": true,
                    "flex-1": !visibleSubagentNavigation(),
                    "overflow-hidden": !!visibleSubagentNavigation(),
                  }}
                >
                  <Show when={props.subagentTitle} keyed>
                    {(title) => (
                      <span
                        data-testid="subagent-session-prompt-badge"
                        class="inline-flex min-w-0 max-w-full shrink items-center truncate rounded-full border border-border-weak-base bg-surface-base px-3 py-1 text-11-medium font-medium text-text-interactive-base shadow-sm"
                        title={title}
                      >
                        {language.t("session.childAgents.promptBadge", { title })}
                      </span>
                    )}
                  </Show>
                  <Show when={childAgentMenu()} keyed>
                    {(menu) => <SessionChildAgentMenu entries={menu.entries} onOpen={menu.onOpen} />}
                  </Show>
                  <Show when={platform.platform === "desktop" && backgroundShells().length > 0}>
                    <SessionBackgroundShellMenu
                      entries={backgroundShells()}
                      loading={backgroundShellsLoading()}
                      onRefresh={refreshBackgroundShells}
                      onOpen={openBackgroundShell}
                    />
                  </Show>
                </div>
                <Show when={visibleSubagentNavigation()} keyed>
                  {(navigation) => (
                    <div class="flex justify-center" data-testid="subagent-session-navigation">
                      <div class="flex items-center gap-0.5 rounded-lg border border-border-weak-base bg-background-stronger px-1 py-0.5 shadow-sm">
                        <Button
                          size="small"
                          variant="ghost"
                          class="rounded-md font-mono text-11-medium tabular-nums text-text-weak hover:text-text-strong disabled:pointer-events-none disabled:opacity-40"
                          disabled={!navigation.previous}
                          aria-label={language.t("command.session.previous")}
                          onClick={() => {
                            if (navigation.previous) navigation.onNavigate(navigation.previous)
                          }}
                        >
                          <Icon name="arrow-left" size="small" />
                          <span class="min-w-4 text-center">{navigation.earlierCount}</span>
                        </Button>
                        <div class="mx-0.5 h-4 w-px bg-border-weak-base" />
                        <Button
                          size="small"
                          variant="ghost"
                          class="rounded-md text-11-medium text-text-weak hover:text-text-strong"
                          aria-label={language.t("command.session.back")}
                          onClick={() => navigation.onNavigate(navigation.parentID)}
                        >
                          <Icon name="arrow-up" size="small" />
                          <span>{language.t("command.session.back")}</span>
                        </Button>
                        <div class="mx-0.5 h-4 w-px bg-border-weak-base" />
                        <Button
                          size="small"
                          variant="ghost"
                          class="rounded-md font-mono text-11-medium tabular-nums text-text-weak hover:text-text-strong disabled:pointer-events-none disabled:opacity-40"
                          disabled={!navigation.next}
                          aria-label={language.t("command.session.next")}
                          onClick={() => {
                            if (navigation.next) navigation.onNavigate(navigation.next)
                          }}
                        >
                          <span class="min-w-4 text-center">{navigation.laterCount}</span>
                          <Icon name="arrow-right" size="small" />
                        </Button>
                      </div>
                    </div>
                  )}
                </Show>
                <Show when={!!visibleSubagentNavigation() || !!userMessageMenu() || skippedQuestionCount() > 0}>
                  <div
                    classList={{
                      "min-w-0 flex items-center justify-end gap-2": true,
                      "flex-1": !visibleSubagentNavigation(),
                    }}
                  >
                    <Show when={userMessageMenu()} keyed>
                      {(menu) => <SessionUserMessageMenu entries={menu.entries} onOpen={menu.onOpen} />}
                    </Show>
                    <Show when={skippedQuestionCount() > 0}>
                      <Button
                        variant="ghost"
                        size="small"
                        class="h-7 shrink-0 rounded-md px-2 text-text-weak hover:text-text-strong"
                        onClick={openSkippedQuestions}
                      >
                        {language.t(
                          props.state.skippedQuestionSessionEnded()
                            ? "session.question.skipped.ended.button"
                            : "session.question.skipped.button",
                          { count: skippedQuestionCount() },
                        )}
                      </Button>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={dock() && platform.platform !== "desktop"}>
              <div
                classList={{
                  "overflow-hidden": true,
                  "pointer-events-none": value() < 0.98,
                }}
                style={{
                  "max-height": `${full() * value()}px`,
                }}
              >
                <div ref={(el) => setStore("body", el)}>
                  <SessionTodoDock
                    sessionID={route.params.id}
                    todos={props.state.todos()}
                    collapseLabel={language.t("session.todo.collapse")}
                    expandLabel={language.t("session.todo.expand")}
                    dockProgress={value()}
                  />
                </div>
              </div>
            </Show>
            <Show when={rolled()} keyed>
              {(revert) => (
                <div
                  style={{
                    "margin-top": `${-36 * value()}px`,
                  }}
                >
                  <SessionRevertDock
                    items={revert.items}
                    restoring={revert.restoring}
                    disabled={revert.disabled}
                    onRestore={revert.onRestore}
                  />
                </div>
              )}
            </Show>
            <div
              classList={{
                "relative z-10": true,
              }}
              style={{
                "margin-top": `${-lift()}px`,
              }}
            >
              <Show when={props.followup?.items.length ? props.followup : undefined}>
                {(followup) => (
                  <SessionFollowupDock
                    items={followup().items}
                    sending={followup().sending}
                    onSend={followup().onSend}
                    onEdit={followup().onEdit}
                  />
                )}
              </Show>
              <PromptInput
                ref={props.inputRef}
                newSessionWorktree={props.newSessionWorktree}
                onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                edit={props.followup?.edit}
                onEditLoaded={props.followup?.onEditLoaded}
                shouldQueue={props.followup?.queue}
                onQueue={props.followup?.onQueue}
                onAbort={props.followup?.onAbort}
                onSubmit={props.onSubmit}
                onSubmitted={props.onSubmitted}
                onScrollToBottom={props.onScrollToBottom}
                scrollState={props.scrollState}
              />
            </div>
          </Show>
        </ComposerDockExit>
      </div>
    </div>
  )
}
