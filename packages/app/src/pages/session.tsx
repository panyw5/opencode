import type { Part, SnapshotFileDiff as FileDiff, Project, UserMessage } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useMutation } from "@tanstack/solid-query"
import {
  batch,
  onCleanup,
  Show,
  Match,
  Switch,
  createMemo,
  createSignal,
  createEffect,
  createComputed,
  on,
  onMount,
  untrack,
} from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Select } from "@opencode-ai/ui/select"
import { Tabs } from "@opencode-ai/ui/tabs"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { Button } from "@opencode-ai/ui/button"
import { taskSessionSiblings } from "@opencode-ai/ui/message-task-session"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode, checksum } from "@opencode-ai/core/util/encode"
import { useLocation, useNavigate, useSearchParams } from "@solidjs/router"
import { setCursorPosition } from "@/components/prompt-input/editor-dom"
import { promptLength } from "@/components/prompt-input/history"
import { NewSessionView, SessionHeader } from "@/components/session"
import { useComments } from "@/context/comments"
import { getSessionPrefetch, SESSION_PREFETCH_TTL } from "@/context/global-sync/session-prefetch"
import { markSessionProfile } from "@/utils/session-profile"
import {
  sessionBackgroundDelay,
  shouldFinishInitialScroll,
  shouldRefreshStaleSession,
} from "@/pages/session/session-switch-performance"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { workspaceKey as directoryKey } from "@/pages/layout/helpers"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSessionHistory } from "@/context/session-history"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import {
  createSessionComposerState,
  SessionComposerRegion,
  SessionStatusFloat,
  SessionTodoFloat,
} from "@/pages/session/composer"
import { SessionMathFloat, type SessionMathWorkerEntry } from "@/pages/session/session-math-float"
import { SessionMathInitializeDialog } from "@/pages/session/composer/session-math-initialize-dialog"
import { buildMathInitializationPrompt } from "@/pages/session/math-initialize"
import { MATH_ORCHESTRATOR_AGENT, mathModeIsInitializing, mathModeLocksAgent } from "@/pages/session/math-mode-agent"
import {
  clipMessages,
  createOpenReviewFile,
  createSessionTabs,
  createSizing,
  focusTerminalById,
  shouldFocusTerminalOnKeyDown,
} from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/timeline/message-timeline"
import { shouldEaseLiveBottom } from "@/pages/session/timeline/measure"
import { type DiffStyle, SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import { useSessionLayout } from "@/pages/session/session-layout"
import { isExtraAgentDirectory } from "@/pages/layout/extra-agents"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { working } from "@/pages/session/session-working"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { historyPageResult } from "@/pages/session/session-history-pagination"
import { useServer } from "@/context/server"
import { domainFromDirectory } from "@/pages/layout/extra-agents"
import { setBackgroundShell } from "@/pages/session/background-shell-api"
import { backgroundSessionTasks } from "@/pages/session/background-task-api"
import {
  collectSessionLayoutMetrics,
  logSessionLayout,
  type SessionLayoutMetrics,
} from "@/pages/session/session-layout-debug"
import { collectSessionChildAgentEntries, type SessionChildAgentEntry } from "@/pages/session/session-child-agents"
import { collectSessionActiveSkills } from "@/pages/session/session-active-skills"
import {
  ensureMathWorker as ensureMathWorkerApi,
  getMathWorkerTask,
  listMathDetails,
  listMathWorkers,
  stopMathWorker as stopMathWorkerApi,
  updateMathWorkerTask,
  type MathWorkerStatus,
} from "@/pages/session/math-worker-api"
import { SessionMathTaskDialog } from "@/pages/session/session-math-task-dialog"
import { Identifier } from "@/utils/id"
import { compareMessages, resolveMessage, sortMessages } from "@/utils/message-order"
import { commandInvocationFromParts, extractPromptFromParts, injectionPreviewFromParts } from "@/utils/prompt"
import { same } from "@/utils/same"
import { formatServerError } from "@/utils/server-errors"
import type { Session } from "@opencode-ai/sdk/v2/client"

const emptyUserMessages: UserMessage[] = []
const scrollBottomThreshold = 16
const settleMs = 1_500
const sessionBackgroundDelayMs = typeof navigator === "undefined" ? 250 : sessionBackgroundDelay(navigator.userAgent)
const sessionTodoDelayMs = typeof navigator === "undefined" ? 500 : sessionBackgroundDelay(navigator.userAgent, 500)
const initialScrollRevealMs = 300
const emptyFollowups: (FollowupDraft & { id: string })[] = []
const smoothBottomSnapDistance = 900
const smoothBottomMaxStep = 180
const smoothBottomEase = 0.32
const smoothBottomMinDistance = 64

type ChangeMode = "git" | "branch" | "session" | "turn"
type VcsMode = "git" | "branch"
type ScrollMode = "live" | "anchored"
type SessionRenderOverlayStatus = "showing" | "hiding" | "hidden"

function mergeKnownSessions(current: Session[], incoming: readonly Session[]): Session[] {
  if (incoming.length === 0) return current

  const byID = new Map(current.map((session) => [session.id, session] as const))
  let changed = false
  for (const session of incoming) {
    const previous = byID.get(session.id)
    if (previous === session) continue
    byID.set(session.id, session)
    changed = true
  }
  if (!changed) return current
  return [...byID.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function list(value: unknown): FileDiff[] {
  // Older/local session records have previously persisted malformed `summary.diffs`
  // values. Treat anything non-array as "no diffs" so a bad record can't crash
  // the entire session view while opening review.
  return Array.isArray(value) ? value : []
}

function joinWorkspacePath(root: string, child: string) {
  const slash = /^[A-Za-z]:\\|\\\\/.test(root) || root.includes("\\") ? "\\" : "/"
  return root.replace(/[\\/]+$/, "") + slash + child.replace(/^[\\/]+/, "")
}

function parentDirectory(input: string) {
  const index = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"))
  return index > 0 ? input.slice(0, index) : input
}

export default function Page() {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const location = useLocation()
  const sdk = useSDK()
  const server = useServer()
  const settings = useSettings()
  const sessionHistory = useSessionHistory()
  const prompt = usePrompt()
  const platform = usePlatform()
  const comments = useComments()
  const terminal = useTerminal()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const { params, sessionKey, tabs, view } = useSessionLayout()

  createEffect(() => {
    if (!untrack(() => prompt.ready())) return
    prompt.ready()
    untrack(() => {
      if (params.id || !prompt.ready()) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  createEffect(
    on(
      sessionKey,
      (key, previous) => {
        console.debug(
          `[session] session-key from=${previous ?? "none"} to=${key} ready=${String(sync.data.message[params.id ?? ""] !== undefined)}`,
        )
      },
      { defer: true },
    ),
  )

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    seekingMessageId: undefined as string | undefined,
    reviewSnap: false,
    scrollGesture: 0,
    mode: "live" as ScrollMode,
    // Keep the first paint covered while timeline scroll settles.
    renderOverlayStatus: (params.id ? "showing" : "hidden") as SessionRenderOverlayStatus,
    scroll: {
      overflow: false,
      bottom: true,
    },
  })

  const composer = createSessionComposerState()

  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()
  const desktopReviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const desktopFilePreviewOpen = createMemo(() => isDesktop() && view().filePreview.opened())
  const desktopFileTreeOpen = createMemo(() => isDesktop() && layout.fileTree.opened())
  const desktopSidePanelOpen = createMemo(
    () => desktopReviewOpen() || desktopFilePreviewOpen() || desktopFileTreeOpen(),
  )
  const sessionPanelWidth = createMemo(() => {
    if (!desktopSidePanelOpen()) return "100%"
    if (desktopReviewOpen() || desktopFilePreviewOpen()) return `${layout.session.width()}px`
    return `calc(100% - ${layout.fileTree.width()}px)`
  })
  const centered = createMemo(() => isDesktop() && !desktopReviewOpen() && !desktopFilePreviewOpen())

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))

  // Track visited opencode sessions in a global history list so the
  // extra-agent (GenericAgent / Hermes / OpenClaw) prompt-input picker can
  // surface them later. Skip extra-agent directories — only real opencode
  // sessions belong in this list.
  createEffect(() => {
    const id = params.id
    if (!id) return
    const directory = info()?.directory
    if (!directory) return
    if (isExtraAgentDirectory(directory)) return
    const title = info()?.title ?? ""
    sessionHistory.record({ id, title, directory })
  })

  const diffs = createMemo(() => (params.id ? (globalSync.session.diff.get(sdk.directory, params.id) ?? []) : []))
  const sessionCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasSessionReview = createMemo(() => sessionCount() > 0)
  const canReview = createMemo(() => !!params.id)
  const reviewTab = createMemo(() => isDesktop())
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const explicitMessageLimit = createMemo(() => {
    const id = params.id
    if (!id) return
    return sync.session.history.limit(id)
  })
  const messages = createMemo(() => {
    const id = params.id
    if (!id) return []
    const all = sync.data.message[id] ?? []
    const ordered = sortMessages(all)
    if (ordered.length > 1 && all[0] && ordered[0] && all[0].id !== ordered[0].id) {
      const first = ordered[0]
      const last = ordered[ordered.length - 1]
      console.debug(
        `[session] message-order corrected sid=${id} n=${String(ordered.length)} first=${first.id}:${String(first.time.created)} last=${last.id}:${String(last.time.created)}`,
      )
    }
    const limit = explicitMessageLimit()
    return clipMessages(ordered, limit)
  })
  const [apiChildSessions, setApiChildSessions] = createSignal<Session[]>([])
  createEffect(
    on(
      () => params.id,
      (id) => {
        setApiChildSessions([])
        if (!id) return

        let cancelled = false
        const timer = window.setTimeout(() => {
          markSessionProfile(id, "children-request-start")
          void sdk.client.session.children({ sessionID: id }).then(
            (result) => {
              if (cancelled) return
              const children = result.data ?? []
              setApiChildSessions(children)
              if (children.length > 0) {
                sync.set("session", (current) => mergeKnownSessions(current, children))
              }
              markSessionProfile(id, "children-request-end", `count=${String(children.length)}`)
            },
            () => {
              if (cancelled) return
              setApiChildSessions([])
              markSessionProfile(id, "children-request-error")
            },
          )
        }, sessionBackgroundDelayMs)
        onCleanup(() => {
          cancelled = true
          window.clearTimeout(timer)
        })
      },
    ),
  )
  const currentApiChildSessions = createMemo(() => {
    const id = params.id
    if (!id) return []
    return apiChildSessions().filter((session) => session.parentID === id)
  })
  const [apiSiblingSessions, setApiSiblingSessions] = createSignal<Session[]>([])
  let loadedSiblingParentID: string | undefined
  createEffect(
    on(
      () => info()?.parentID,
      (parentID) => {
        if (!parentID) return
        if (loadedSiblingParentID === parentID && apiSiblingSessions().length > 0) return
        setApiSiblingSessions([])

        let cancelled = false
        const id = params.id
        const timer = window.setTimeout(() => {
          if (id) markSessionProfile(id, "siblings-request-start")
          void sdk.client.session.children({ sessionID: parentID }).then(
            (result) => {
              if (cancelled) return
              const siblings = result.data ?? []
              setApiSiblingSessions(siblings)
              loadedSiblingParentID = parentID
              if (id) markSessionProfile(id, "siblings-request-end", `count=${String(siblings.length)}`)
            },
            () => {
              if (cancelled) return
              setApiSiblingSessions([])
              if (id) markSessionProfile(id, "siblings-request-error")
            },
          )
        }, sessionBackgroundDelayMs)
        onCleanup(() => {
          cancelled = true
          window.clearTimeout(timer)
        })
      },
    ),
  )
  const subagentNavigation = createMemo(() => {
    const sessionID = params.id
    const parentSessionID = info()?.parentID
    if (!sessionID || !parentSessionID) return undefined

    const byID = new Map<string, Session>()
    for (const session of sync.data.session) {
      if (session.parentID !== parentSessionID) continue
      byID.set(session.id, session)
    }
    for (const session of apiSiblingSessions()) {
      byID.set(session.id, session)
    }

    const siblings = taskSessionSiblings({
      parentSessionId: parentSessionID,
      sessions: [...byID.values()],
    })
    const index = siblings.findIndex((session) => session.id === sessionID)
    if (index < 0) return undefined
    return {
      parentID: parentSessionID,
      previous: siblings[index - 1]?.id,
      next: siblings[index + 1]?.id,
      earlierCount: index,
      laterCount: Math.max(0, siblings.length - index - 1),
      onNavigate: openSubagentSession,
    }
  })
  const subagentPromptTitle = createMemo(() => {
    const session = info()
    if (!session?.parentID) return undefined
    const raw = (session.title ?? "").trim()
    if (!raw) return undefined
    const cleaned = raw
      .replace(/^\[im:[^\]]*\]\s*/, "")
      .replace(/^\[scheduled\]\s*/, "")
      .replace(/\s+\(@[^)]*\s+subagent\)$/i, "")
      .trim()
    return cleaned || raw
  })
  const mathModeAvailable = createMemo(() => !subagentPromptTitle() && local.agent.available(MATH_ORCHESTRATOR_AGENT))
  const childAgentSessions = createMemo(() => {
    const id = params.id
    if (!id) return []

    const byID = new Map<string, Session>()
    for (const session of sync.data.session) {
      if (session.parentID !== id) continue
      byID.set(session.id, session)
    }
    for (const session of currentApiChildSessions()) {
      byID.set(session.id, session)
    }
    return [...byID.values()]
  })
  const [mathMode, setMathMode] = createStore({
    prepared: false,
    initializingSessionID: undefined as string | undefined,
  })
  createEffect(
    on(
      () => params.id,
      (sessionID) => {
        const pendingSessionID = untrack(() => mathMode.initializingSessionID)
        console.debug(
          `[math-initialize] session changed session=${sessionID ?? "draft"} pending=${pendingSessionID ?? "none"}`,
        )
        if (pendingSessionID !== sessionID) {
          setMathMode("prepared", false)
          if (pendingSessionID) {
            console.debug(`[math-initialize] clear pending session=${pendingSessionID} reason=session-changed`)
            setMathMode("initializingSessionID", undefined)
          }
        }
      },
      { defer: true },
    ),
  )
  const mathModeInitializationRequested = createMemo(() => !!params.id && mathMode.initializingSessionID === params.id)
  const mathModeAgentLocked = createMemo(() =>
    mathModeLocksAgent({
      prepared: mathMode.prepared,
      sessionAgent: info()?.agent,
      childAgents: childAgentSessions().map((session) => session.agent),
      subagent: !!subagentPromptTitle(),
    }),
  )
  createEffect(() => {
    if (!mathModeAgentLocked()) return
    console.debug(
      `[math-mode] agent lock enabled session=${params.id ?? "draft"} reason=${mathMode.prepared ? "prepared" : info()?.agent === MATH_ORCHESTRATOR_AGENT ? "session-agent" : "durable-worker"}`,
    )
    local.agent.lock(MATH_ORCHESTRATOR_AGENT)
    onCleanup(() => {
      local.agent.lock(undefined)
      console.debug(`[math-mode] agent lock released session=${params.id ?? "draft"}`)
    })
  })
  const childAgentEntries = createMemo(() =>
    collectSessionChildAgentEntries({
      sessionID: params.id,
      messages: messages(),
      parts: sync.data.part,
      sessions: childAgentSessions(),
      messagesBySession: sync.data.message,
      statuses: sync.session.status.all(),
    }).filter((entry) => entry.agent !== "math-worker"),
  )
  const [mathSwarm, setMathSwarm] = createStore({
    workers: [] as MathWorkerStatus[],
    busy: {} as Record<string, boolean>,
  })
  let mathSwarmRequest = 0
  const mathSwarmEnabled = createMemo(
    () =>
      info()?.agent === "math-orchestrator" ||
      childAgentSessions().some((session) => session.agent === "math-worker") ||
      mathSwarm.workers.length > 0 ||
      mathModeInitializationRequested(),
  )
  const refreshMathSwarm = async (parentSessionID: string) => {
    const request = ++mathSwarmRequest
    console.debug(
      `[math-swarm] refresh start parent=${parentSessionID} request=${request} initializing=${String(mathModeInitializationRequested())}`,
    )
    try {
      const workers = await listMathWorkers({
        sdk,
        platform,
        auth: server.currentFor(domainFromDirectory(sdk.directory))?.http,
        parentSessionID,
      })
      if (request !== mathSwarmRequest) {
        console.debug(`[math-swarm] refresh stale parent=${parentSessionID} request=${request}`)
        return
      }
      setMathSwarm("workers", workers)
      console.debug(
        `[math-swarm] refresh finish parent=${parentSessionID} request=${request} workers=${workers.length}`,
      )
    } catch (error) {
      if (request !== mathSwarmRequest) return
      console.warn(
        `[math-swarm] refresh failed parent=${parentSessionID} request=${request} error=${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  createEffect(
    on(
      () => {
        const current = info()
        if (current?.agent !== "math-worker" || !current.parentID) return
        return { parentSessionID: current.parentID, workerSessionID: current.id }
      },
      (target) => {
        if (!target) return
        let cancelled = false
        const reconcileChild = async () => {
          console.debug(
            `[math-swarm] child reconcile start parent=${target.parentSessionID} worker=${target.workerSessionID}`,
          )
          try {
            const workers = await listMathWorkers({
              sdk,
              platform,
              auth: server.currentFor(domainFromDirectory(sdk.directory))?.http,
              parentSessionID: target.parentSessionID,
            })
            if (cancelled) return
            const worker = workers.find((entry) => entry.sessionID === target.workerSessionID)
            const running = worker?.alive === true && worker.state === "running"
            globalSync.session.status.set(sdk.directory, target.workerSessionID, {
              type: running ? "busy" : "idle",
            })
            console.debug(
              `[math-swarm] child reconcile finish parent=${target.parentSessionID} worker=${target.workerSessionID} found=${String(!!worker)} alive=${String(worker?.alive ?? false)} state=${worker?.state ?? "missing"} ui=${running ? "busy" : "idle"}`,
            )
          } catch (error) {
            console.warn(
              `[math-swarm] child reconcile failed parent=${target.parentSessionID} worker=${target.workerSessionID} error=${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        void reconcileChild()
        const timer = window.setInterval(() => void reconcileChild(), 10_000)
        onCleanup(() => {
          cancelled = true
          window.clearInterval(timer)
        })
      },
    ),
  )
  createEffect(() => {
    const parentSessionID = params.id
    if (!parentSessionID || !mathSwarmEnabled()) {
      mathSwarmRequest += 1
      setMathSwarm("workers", [])
      return
    }
    void refreshMathSwarm(parentSessionID)
    const timer = window.setInterval(() => void refreshMathSwarm(parentSessionID), 10_000)
    onCleanup(() => {
      mathSwarmRequest += 1
      window.clearInterval(timer)
    })
  })
  const mathWorkerEntries = createMemo<SessionMathWorkerEntry[]>(() => {
    const titles = new Map(childAgentSessions().map((session) => [session.id, session.title] as const))
    return mathSwarm.workers.map((worker) => ({
      ...worker,
      title: titles.get(worker.sessionID)?.trim() || `math-worker ${worker.sessionID.slice(-6)}`,
    }))
  })
  const mathModeInitializing = createMemo(() =>
    mathModeIsInitializing({
      sessionID: params.id,
      requestedSessionID: mathMode.initializingSessionID,
      workerCount: mathSwarm.workers.length,
    }),
  )
  createEffect(() => {
    const requestedSessionID = mathMode.initializingSessionID
    if (!requestedSessionID || requestedSessionID !== params.id || mathSwarm.workers.length === 0) return
    console.debug(
      `[math-initialize] worker assignment complete session=${requestedSessionID} workers=${mathSwarm.workers.length}`,
    )
    setMathMode("initializingSessionID", undefined)
  })
  let lastMathInitializationState = ""
  createEffect(() => {
    const state = `${params.id ?? "draft"}:${mathMode.initializingSessionID ?? "none"}:${String(mathSwarm.workers.length)}:${String(mathModeInitializing())}`
    if (state === lastMathInitializationState) return
    lastMathInitializationState = state
    console.debug(
      `[math-initialize] state session=${params.id ?? "draft"} requested=${mathMode.initializingSessionID ?? "none"} workers=${mathSwarm.workers.length} initializing=${String(mathModeInitializing())}`,
    )
  })
  const mathWorkersBusy = createMemo(() => Object.keys(mathSwarm.busy).filter((id) => mathSwarm.busy[id]))
  const activeSkills = createMemo(() =>
    collectSessionActiveSkills({
      messages: messages(),
      parts: sync.data.part,
    }),
  )
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const sessionRenderOverlayStatus = createMemo<SessionRenderOverlayStatus>(() => {
    if (params.id && !messagesReady()) return "showing"
    return ui.renderOverlayStatus
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })
  const diffsReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    if (!hasSessionReview()) return true
    return globalSync.session.diff.get(sdk.directory, id) !== undefined
  })

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      const boundary = resolveMessage(messages(), revert) ?? resolveMessage(userMessages(), revert)
      if (!boundary) return userMessages().filter((m) => m.id < revert)
      return userMessages().filter((m) => compareMessages(m, boundary) < 0)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) file.load(path)
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
    mobileTab: "session" as "session" | "changes",
    changes: "git" as ChangeMode,
    newSessionWorktree: "main",
    newSessionPicked: false,
  })

  const [vcs, setVcs] = createStore({
    diff: {
      git: [] as FileDiff[],
      branch: [] as FileDiff[],
    },
    ready: {
      git: false,
      branch: false,
    },
  })

  const [followup, setFollowup] = createStore({
    items: {} as Record<string, (FollowupDraft & { id: string })[] | undefined>,
    failed: {} as Record<string, string | undefined>,
    paused: {} as Record<string, boolean | undefined>,
    edit: {} as Record<
      string,
      { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] } | undefined
    >,
  })

  let root: HTMLDivElement | undefined
  let reviewFrame: number | undefined
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let refreshRun = 0
  let diffFrame: number | undefined
  let diffTimer: number | undefined
  const vcsTask = new Map<VcsMode, Promise<void>>()
  const vcsRun = new Map<VcsMode, number>()

  const bumpVcs = (mode: VcsMode) => {
    const next = (vcsRun.get(mode) ?? 0) + 1
    vcsRun.set(mode, next)
    return next
  }

  const resetVcs = (mode?: VcsMode) => {
    const list = mode ? [mode] : (["git", "branch"] as const)
    list.forEach((item) => {
      bumpVcs(item)
      vcsTask.delete(item)
      setVcs("diff", item, [])
      setVcs("ready", item, false)
    })
  }

  const loadVcs = (mode: VcsMode, force = false) => {
    if (sync.project?.vcs !== "git") return Promise.resolve()
    if (!force && vcs.ready[mode]) return Promise.resolve()

    if (force) {
      if (vcsTask.has(mode)) bumpVcs(mode)
      vcsTask.delete(mode)
      setVcs("ready", mode, false)
    }

    const current = vcsTask.get(mode)
    if (current) return current

    const run = bumpVcs(mode)

    const task = sdk.client.vcs
      .diff({ mode })
      .then((result) => {
        if (vcsRun.get(mode) !== run) return
        setVcs("diff", mode, result.data ?? [])
        setVcs("ready", mode, true)
      })
      .catch((error) => {
        if (vcsRun.get(mode) !== run) return
        setVcs("diff", mode, [])
        setVcs("ready", mode, true)
      })
      .finally(() => {
        if (vcsTask.get(mode) === task) vcsTask.delete(mode)
      })

    vcsTask.set(mode, task)
    return task
  }

  const refreshVcs = () => {
    resetVcs()
    const mode = untrack(vcsMode)
    if (!mode) return
    if (!untrack(wantsReview)) return
    void loadVcs(mode, true)
  }

  createComputed((prev) => {
    const open = desktopReviewOpen()
    if (prev === undefined || prev === open) return open

    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    setUi("reviewSnap", true)
    reviewFrame = requestAnimationFrame(() => {
      reviewFrame = undefined
      setUi("reviewSnap", false)
    })
    return open
  }, desktopReviewOpen())

  const turnDiffs = createMemo(() => list(lastUserMessage()?.summary?.diffs))
  const changesOptions = createMemo<ChangeMode[]>(() => {
    const list: ChangeMode[] = []
    if (sync.project?.vcs === "git") list.push("git")
    if (
      sync.project?.vcs === "git" &&
      sync.data.vcs?.branch &&
      sync.data.vcs?.default_branch &&
      sync.data.vcs.branch !== sync.data.vcs.default_branch
    ) {
      list.push("branch")
    }
    list.push("session", "turn")
    return list
  })
  const vcsMode = createMemo<VcsMode | undefined>(() => {
    if (store.changes === "git" || store.changes === "branch") return store.changes
  })
  const reviewDiffs = createMemo(() => {
    if (store.changes === "git") return vcs.diff.git
    if (store.changes === "branch") return vcs.diff.branch
    if (store.changes === "session") return diffs()
    return turnDiffs()
  })
  const reviewCount = createMemo(() => {
    if (store.changes === "git") return vcs.diff.git.length
    if (store.changes === "branch") return vcs.diff.branch.length
    if (store.changes === "session") return sessionCount()
    return turnDiffs().length
  })
  const hasReview = createMemo(() => reviewCount() > 0)
  const reviewReady = createMemo(() => {
    if (store.changes === "git") return vcs.ready.git
    if (store.changes === "branch") return vcs.ready.branch
    if (store.changes === "session") return !hasSessionReview() || diffsReady()
    return true
  })

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    if (store.newSessionPicked) return store.newSessionWorktree
    const project = sync.project
    const directory = sdk.directory
    if (project && directory && directory.trim() !== "" && directory !== project.worktree) {
      return directory
    }
    return "main"
  })

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    console.debug(
      `[session] message offset navigation: offset=${offset} current=${current || "none"} currentIndex=${currentIndex} targetIndex=${targetIndex} total=${msgs.length}`,
    )
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  const sessionEmptyKey = createMemo(() => {
    const project = sync.project
    if (project && !project.vcs) return "session.review.noVcs"
    if (sync.data.config.snapshot === false) return "session.review.noSnapshot"
    return "session.review.empty"
  })

  function upsert(next: Project) {
    const list = globalSync.data.project
    sync.set("project", next.id)
    const idx = list.findIndex((item) => item.id === next.id)
    if (idx >= 0) {
      globalSync.set(
        "project",
        list.map((item, i) => (i === idx ? { ...item, ...next } : item)),
      )
      return
    }
    const at = list.findIndex((item) => item.id > next.id)
    if (at >= 0) {
      globalSync.set("project", [...list.slice(0, at), next, ...list.slice(at)])
      return
    }
    globalSync.set("project", [...list, next])
  }

  const gitMutation = useMutation(() => ({
    mutationFn: () => sdk.client.project.initGit(),
    onSuccess: (x) => {
      if (!x.data) return
      upsert(x.data)
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
    },
  }))

  function initGit() {
    if (gitMutation.isPending) return
    gitMutation.mutate()
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let revealMessage = (_id: string) => {}
  let prepareMessageNavigation = () => {}
  let scrollToEnd = () => {}
  let historyAnchor = { capture: () => {}, restore: (_done: boolean) => {} }
  let scrollMark = 0
  let messageMark = 0
  let findNavigationUntil = 0

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    findNavigationUntil = 0
    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  const lagKey = "opencode.session.lag.debug"

  const lagging = () => {
    if (typeof window === "undefined") return false
    return window.localStorage.getItem(lagKey) === "1"
  }

  const lag = (kind: string, fields: Record<string, string | number | boolean>) => {
    if (!lagging()) return
    const line = Object.entries(fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ")
    console.debug(`[lag] ${kind} ${line}`)
  }

  const sampleDom = () => {
    const root = scroller
    if (!root) return
    const list = content?.querySelector<HTMLElement>('[data-slot="session-turn-list"]')
    return {
      nodes: root.querySelectorAll("*").length,
      markdown: root.querySelectorAll('[data-component="markdown"]').length,
      full: root.querySelectorAll('[data-component="markdown"][data-markdown-stage="full"]').length,
      structure: root.querySelectorAll('[data-component="markdown"][data-markdown-stage="structure"]').length,
      lite: root.querySelectorAll('[data-component="markdown"][data-markdown-stage="lite"]').length,
      katex: root.querySelectorAll(".katex,.katex-display,.katex-html,.katex-mathml").length,
      buttons: root.querySelectorAll("button,[role='button']").length,
      listHeight: list ? Math.round(list.getBoundingClientRect().height) : "none",
      scrollTop: Math.round(root.scrollTop),
      scrollHeight: Math.round(root.scrollHeight),
      clientHeight: Math.round(root.clientHeight),
    }
  }

  const watchLag = (kind: string, target: EventTarget | null) => {
    if (!lagging()) return
    const now = performance.now()
    const el = target instanceof HTMLElement ? target : undefined
    const tag = el?.tagName.toLowerCase() || "unknown"
    const cls = el?.className && typeof el.className === "string" ? el.className.slice(0, 80) : "none"
    requestAnimationFrame(() => {
      const first = performance.now()
      requestAnimationFrame(() => {
        const second = performance.now()
        const total = Math.round(second - now)
        if (total < 50) return
        const dom = sampleDom()
        lag(kind, {
          sid: params.id || "none",
          total,
          first: Math.round(first - now),
          second: Math.round(second - now),
          tag,
          cls,
          ...dom,
        })
      })
    })
  }

  const debug = (src: string, el = scroller, extra: SessionLayoutMetrics = {}) => {
    if (!lagging()) return
    const metrics = collectSessionLayoutMetrics({
      root: el,
      content,
      sessionId: params.id,
      directory: sdk.directory,
      renderedCount: visibleUserMessages().length,
      visibleCount: visibleUserMessages().length,
      currentId: store.messageId,
      seekingId: ui.seekingMessageId,
      live: live(),
    })
    logSessionLayout(`page:${src}`, metrics, extra)
  }

  createEffect(
    on([() => sdk.directory, () => params.id] as const, ([directory, id]) => {
      const run = ++refreshRun
      if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshFrame = undefined
      refreshTimer = undefined
      if (!id) return

      const cached = untrack(() => sync.data.message[id] !== undefined)
      const sharedHistory = untrack(() => globalSync.child(directory, { bootstrap: false })[0].session_history?.[id])
      const stale = !cached
        ? false
        : (() => {
            const info = getSessionPrefetch(directory, id)
            if (!info) {
              if (!sharedHistory?.at) return false
              return Date.now() - sharedHistory.at > SESSION_PREFETCH_TTL
            }
            return Date.now() - info.at > SESSION_PREFETCH_TTL
          })()
      const todos = untrack(() => globalSync.session.todo.get(directory, id) !== undefined)
      markSessionProfile(id, "route-effect", `cached=${String(cached)} stale=${String(stale)}`)

      const initialSync = untrack(() => sync.session.sync(id))
      untrack(() => {
        void sync.session.userMessageIndex.ensure(id).catch((error) => {
          if (run !== refreshRun || params.id !== id || sdk.directory !== directory) return
          console.debug(
            `[user-message-menu] index-error sid=${id} error=${error instanceof Error ? error.message : String(error)}`,
          )
        })
      })
      markSessionProfile(id, "todo-request-scheduled", `delayMs=${String(sessionTodoDelayMs)} force=${String(todos)}`)

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (run !== refreshRun || params.id !== id || sdk.directory !== directory) return
          untrack(() => {
            markSessionProfile(id, "todo-request-start", `force=${String(todos)}`)
            void sync.session.todo(id, todos ? { force: true } : undefined).then(
              () => {
                if (run !== refreshRun || params.id !== id || sdk.directory !== directory) return
                markSessionProfile(id, "todo-request-end")
              },
              (error) => {
                if (run !== refreshRun || params.id !== id || sdk.directory !== directory) return
                markSessionProfile(
                  id,
                  "todo-request-error",
                  `error=${error instanceof Error ? error.message : String(error)}`,
                )
              },
            )
          })
          const refresh = () => {
            if (run !== refreshRun || params.id !== id || sdk.directory !== directory) return
            untrack(() => {
              const current = getSessionPrefetch(directory, id)
              const stillStale = shouldRefreshStaleSession({
                wasStale: stale,
                refreshedAt: current?.at,
                now: Date.now(),
                ttl: SESSION_PREFETCH_TTL,
              })
              if (stillStale) {
                markSessionProfile(id, "stale-refresh-scheduled")
                void sync.session.sync(id, { force: true })
              } else if (stale) {
                markSessionProfile(id, "stale-refresh-skipped", "reason=initial-sync")
              }
            })
          }
          void initialSync.then(refresh, refresh)
        }, sessionTodoDelayMs)
      })
    }),
  )

  // Scheduled tasks (and other external writers) don't go through optimistic UI.
  // When a run targets the open session, force a message refresh so the timeline
  // updates without leaving and re-entering the page.
  const globalSDK = useGlobalSDK()
  createEffect(() => {
    const id = params.id
    const dir = sdk.directory
    if (!id || !dir) return
    const dirKey = directoryKey(dir)
    let timer: number | undefined
    const refresh = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = undefined
        if (params.id !== id) return
        void sync.session.sync(id, { force: true })
      }, 150)
    }
    const stop = globalSDK.listenAll((e) => {
      const type = e.details.type as string
      if (type === "scheduled-task.run-updated") {
        const run = (e.details as { properties?: { sessionID?: string } }).properties
        if (run?.sessionID === id) refresh()
        return
      }
      if (directoryKey(e.name) !== dirKey) return
      if (
        type === "message.updated" ||
        type === "message.part.updated" ||
        type === "message.part.delta" ||
        type === "session.status"
      ) {
        const props = (e.details as { properties?: Record<string, unknown> }).properties ?? {}
        const info = props.info as { id?: string; sessionID?: string } | undefined
        const part = props.part as { sessionID?: string } | undefined
        const sessionID = (props.sessionID as string | undefined) ?? info?.sessionID ?? part?.sessionID
        if (sessionID !== id) return
        // Events should already apply via global-sync; if a message.updated was
        // missed (path alias / race), force a sync so the open view catches up.
        if (type === "message.updated" && info?.id) {
          const messages = untrack(() => sync.data.message[id])
          if (!messages?.some((m) => m.id === info.id)) refresh()
        }
      }
    })
    onCleanup(() => {
      stop()
      if (timer !== undefined) window.clearTimeout(timer)
    })
  })

  createEffect(() => {
    const el = root
    if (!el) return
    const over = (e: PointerEvent) => watchLag("hover", e.target)
    const down = (e: PointerEvent) => watchLag("down", e.target)
    const click = (e: MouseEvent) => watchLag("click", e.target)
    const wheel = (e: WheelEvent) => watchLag("wheel", e.target)
    el.addEventListener("pointerover", over, true)
    el.addEventListener("pointerdown", down, true)
    el.addEventListener("click", click, true)
    el.addEventListener("wheel", wheel, true)
    onCleanup(() => {
      el.removeEventListener("pointerover", over, true)
      el.removeEventListener("pointerdown", down, true)
      el.removeEventListener("click", click, true)
      el.removeEventListener("wheel", wheel, true)
    })
  })

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("changes", "git")
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  // Must run during the same reactive turn as params.id change — deferred
  // effects paint one empty frame with the previous "hidden" overlay state.
  createComputed(
    on(
      () => params.id,
      (id, prev) => {
        if (!id || id === prev) return
        if (!prev) return
        setUi("renderOverlayStatus", "showing")
      },
    ),
  )

  createEffect(
    on(
      () => sdk.directory,
      () => {
        resetVcs()
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [sync.data.vcs?.branch, sync.data.vcs?.default_branch] as const,
      (next, prev) => {
        if (prev === undefined || same(next, prev)) return
        refreshVcs()
      },
      { defer: true },
    ),
  )

  const stopVcs = sdk.event.listen((evt) => {
    if (evt.details.type !== "file.watcher.updated") return
    const props =
      typeof evt.details.properties === "object" && evt.details.properties
        ? (evt.details.properties as Record<string, unknown>)
        : undefined
    const file = typeof props?.file === "string" ? props.file : undefined
    if (!file || file.startsWith(".git/")) return
    refreshVcs()
  })
  onCleanup(stopVcs)

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
        setStore("newSessionPicked", false)
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    // Prefer the open terminal over the composer when it can take focus
    if (view().terminal.opened()) {
      const id = terminal.active()
      if (id && shouldFocusTerminalOnKeyDown(event) && focusTerminalById(id)) return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (composer.blocked()) return
      inputRef?.focus()
    }
  }

  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")
  const wantsReview = createMemo(() =>
    isDesktop()
      ? desktopFileTreeOpen() || (desktopReviewOpen() && activeTab() === "review")
      : store.mobileTab === "changes",
  )

  createEffect(() => {
    const list = changesOptions()
    if (list.includes(store.changes)) return
    const next = list[0]
    if (!next) return
    setStore("changes", next)
  })

  createEffect(() => {
    const mode = vcsMode()
    if (!mode) return
    if (!wantsReview()) return
    void loadVcs(mode)
  })

  createEffect(
    on(
      () => sync.session.status.get(params.id ?? "")?.type,
      (next, prev) => {
        const mode = vcsMode()
        if (!mode) return
        if (!wantsReview()) return
        if (next !== "idle" || prev === undefined || prev === "idle") return
        void loadVcs(mode, true)
      },
      { defer: true },
    ),
  )

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({
          reviewScroll: undefined,
          pendingDiff: undefined,
          activeDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => {
    const input = inputRef
    if (!input) return
    requestAnimationFrame(() => {
      if (!input.isConnected) return
      input.focus()
      setCursorPosition(input, promptLength(prompt.current()))
    })
  }
  const openChildAgent = (entry: SessionChildAgentEntry): void => {
    const dir = params.dir
    if (!dir) return
    navigate(`/${dir}/session/${entry.sessionID}`)
  }
  const openMathWorkerSession = (sessionID: string): void => {
    const dir = params.dir
    if (!dir) return
    navigate(`/${dir}/session/${sessionID}`)
  }
  const openMathWorker = (entry: SessionMathWorkerEntry): void => openMathWorkerSession(entry.sessionID)
  const openMathInitialize = () => {
    const current = local.model.current()
    const defaultModel = current ? `${current.provider.id}/${current.id}` : ""
    dialog.show(() => (
      <SessionMathInitializeDialog
        defaultModel={defaultModel}
        defaultVerifierModel={mathSwarm.workers[0]?.verifierModel ?? defaultModel}
        onConfirm={(config) => {
          const text = buildMathInitializationPrompt(config)
          console.debug(
            `[math-initialize] confirmed project=${config.project} high=${config.highWorkers} xhigh=${config.xhighWorkers} promptLength=${text.length}`,
          )
          setMathMode("prepared", true)
          setMathMode("initializingSessionID", undefined)
          local.agent.lock(MATH_ORCHESTRATOR_AGENT)
          prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
          requestAnimationFrame(() => inputRef?.focus())
        }}
      />
    ))
  }
  const ensureMathWorker = async (entry: SessionMathWorkerEntry, reEnable = false) => {
    const parentSessionID = params.id
    if (!parentSessionID || mathSwarm.busy[entry.sessionID]) return
    setMathSwarm("busy", entry.sessionID, true)
    try {
      await ensureMathWorkerApi({
        sdk,
        platform,
        auth: server.currentFor(domainFromDirectory(sdk.directory))?.http,
        parentSessionID,
        workerSessionID: entry.sessionID,
        project: entry.project,
        reEnable,
      })
      await refreshMathSwarm(parentSessionID)
      showToast({
        variant: "success",
        title: language.t(reEnable ? "session.mathSwarm.reEnabled" : "session.mathSwarm.ensured"),
        description: entry.title,
      })
    } catch (error) {
      fail(error)
    } finally {
      setMathSwarm("busy", entry.sessionID, false)
    }
  }
  const updateVerifierModel = async (entry: SessionMathWorkerEntry, verifierModel: string) => {
    const parentSessionID = params.id
    if (!parentSessionID || mathSwarm.busy[entry.sessionID]) return
    setMathSwarm("busy", entry.sessionID, true)
    console.debug(
      `[math-swarm] verifier model update start parent=${parentSessionID} project=${entry.project ?? "default"} model=${verifierModel}`,
    )
    try {
      await ensureMathWorkerApi({
        sdk,
        platform,
        auth: server.currentFor(domainFromDirectory(sdk.directory))?.http,
        parentSessionID,
        workerSessionID: entry.sessionID,
        project: entry.project,
        verifierModel,
      })
      await refreshMathSwarm(parentSessionID)
      console.debug(
        `[math-swarm] verifier model update complete parent=${parentSessionID} project=${entry.project ?? "default"} model=${verifierModel}`,
      )
      showToast({
        variant: "success",
        title: language.t("session.mathSwarm.verifierModel.saved"),
        description: verifierModel,
      })
    } catch (error) {
      console.error(
        `[math-swarm] verifier model update failed parent=${parentSessionID} project=${entry.project ?? "default"} model=${verifierModel} error=${error instanceof Error ? error.message : String(error)}`,
      )
      fail(error)
      throw error
    } finally {
      setMathSwarm("busy", entry.sessionID, false)
    }
  }
  const stopMathWorker = async (entry: SessionMathWorkerEntry) => {
    const parentSessionID = params.id
    if (!parentSessionID || mathSwarm.busy[entry.sessionID]) return
    setMathSwarm("busy", entry.sessionID, true)
    console.debug(
      `[math-swarm] stop start parent=${parentSessionID} worker=${entry.sessionID} project=${entry.project ?? "default"} pid=${entry.pid ?? "unknown"} state=${entry.state}`,
    )
    try {
      const result = await stopMathWorkerApi({
        sdk,
        platform,
        auth: server.currentFor(domainFromDirectory(sdk.directory))?.http,
        parentSessionID,
        workerSessionID: entry.sessionID,
        project: entry.project,
      })
      console.debug(
        `[math-swarm] stop response worker=${entry.sessionID} pid=${result.pid ?? "unknown"} alive=${result.alive} state=${result.state} stopRequested=${result.stopRequested ?? true}`,
      )
      await refreshMathSwarm(parentSessionID)
      console.debug(`[math-swarm] stop refresh complete parent=${parentSessionID} worker=${entry.sessionID}`)
      showToast({ variant: "success", title: language.t("session.mathSwarm.stopped"), description: entry.title })
    } catch (error) {
      console.error(
        `[math-swarm] stop failed worker=${entry.sessionID} error=${error instanceof Error ? error.message : String(error)}`,
      )
      fail(error)
    } finally {
      setMathSwarm("busy", entry.sessionID, false)
    }
  }
  const stopCurrentMathWorkerOnAbort = async () => {
    const current = info()
    if (current?.agent !== "math-worker" || !current.parentID) return
    const worker = mathSwarm.workers.find((entry) => entry.sessionID === current.id)
    console.debug(
      `[math-swarm] composer stop start parent=${current.parentID} worker=${current.id} project=${worker?.project ?? "default"}`,
    )
    const result = await stopMathWorkerApi({
      sdk,
      platform,
      auth: server.currentFor(domainFromDirectory(sdk.directory))?.http,
      parentSessionID: current.parentID,
      workerSessionID: current.id,
      project: worker?.project,
    })
    console.debug(
      `[math-swarm] composer stop finish parent=${current.parentID} worker=${current.id} alive=${result.alive} state=${result.state}`,
    )
  }
  const editMathWorkerTask = async (entry: SessionMathWorkerEntry) => {
    const parentSessionID = params.id
    if (!parentSessionID || mathSwarm.busy[entry.sessionID]) return
    setMathSwarm("busy", entry.sessionID, true)
    try {
      const auth = server.currentFor(domainFromDirectory(sdk.directory))?.http
      const info = await getMathWorkerTask({
        sdk,
        platform,
        auth,
        parentSessionID,
        workerSessionID: entry.sessionID,
        project: entry.project,
      })
      dialog.show(() => (
        <SessionMathTaskDialog
          worker={entry}
          task={info.task}
          onSave={async (task) => {
            await updateMathWorkerTask({
              sdk,
              platform,
              auth,
              parentSessionID,
              workerSessionID: entry.sessionID,
              project: entry.project,
              task,
            })
            await refreshMathSwarm(parentSessionID)
            showToast({ variant: "success", title: language.t("session.mathTask.updated"), description: entry.title })
          }}
        />
      ))
    } catch (error) {
      fail(error)
    } finally {
      setMathSwarm("busy", entry.sessionID, false)
    }
  }
  function openSubagentSession(sessionID: string): void {
    const dir = params.dir
    if (!dir) return
    navigate(`/${dir}/session/${sessionID}`)
  }

  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
    explicitMessages: messages,
    visibleUserMessages,
    review: reviewTab,
  })

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const handleFileLinkClick = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const link = target.closest("a[data-file-link]")
    if (!(link instanceof HTMLAnchorElement)) return

    event.preventDefault()
    const raw = link.dataset.path ?? ""
    const path = file.normalize(raw)
    const line = Number.parseInt(link.dataset.line ?? "", 10)
    const mod = event.metaKey ? "cmd" : event.ctrlKey ? "ctrl" : "none"
    console.debug(
      `[file-link] click session=${params.id ?? "none"} root=${sdk.directory} raw=${raw || "none"} path=${path || "none"} line=${Number.isFinite(line) ? line : "none"} mod=${mod}`,
    )
    if (!path) {
      console.warn(`[file-link] ignored empty path session=${params.id ?? "none"} root=${sdk.directory}`)
      return
    }

    if (event.metaKey || event.ctrlKey) {
      // Cmd+click / Ctrl+click: open the file's folder in the OS file manager.
      if (platform.platform !== "desktop" || !server.isLocal() || (!platform.openInFinder && !platform.openPath)) {
        console.warn(
          `[file-link] reveal unavailable session=${params.id ?? "none"} platform=${platform.platform} local=${String(server.isLocal())}`,
        )
        return
      }
      const target = joinWorkspacePath(sdk.directory, path)
      console.debug(`[file-link] reveal session=${params.id ?? "none"} target=${target}`)
      const open = platform.openInFinder ? platform.openInFinder(target) : platform.openPath!(parentDirectory(target))
      void Promise.resolve(open)
        .then(() => console.debug(`[file-link] revealed session=${params.id ?? "none"} target=${target}`))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          console.warn(`[file-link] reveal failed session=${params.id ?? "none"} target=${target} err=${message}`)
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: message,
          })
        })
      return
    }

    const tab = file.tab(path)
    tabs().open(tab)
    void file.load(path).then(() => {
      const state = file.get(path)
      console.debug(
        `[file-link] load session=${params.id ?? "none"} root=${sdk.directory} path=${path} loaded=${String(!!state?.loaded)} error=${state?.error ?? "none"}`,
      )
    })
    if (Number.isFinite(line) && line > 0) file.setSelectedLines(path, { start: line, end: line })
    if (!view().filePreview.opened()) view().filePreview.open()
    tabs().setActive(tab)
    console.debug(`[file-link] opened session=${params.id ?? "none"} root=${sdk.directory} path=${path} tab=${tab}`)
  }

  const changesTitle = () => {
    if (!canReview()) {
      return null
    }

    const label = (option: ChangeMode) => {
      if (option === "git") return language.t("ui.sessionReview.title.git")
      if (option === "branch") return language.t("ui.sessionReview.title.branch")
      if (option === "session") return language.t("ui.sessionReview.title")
      return language.t("ui.sessionReview.title.lastTurn")
    }

    return (
      <Select
        options={changesOptions()}
        current={store.changes}
        label={label}
        onSelect={(option) => option && setStore("changes", option)}
        variant="ghost"
        size="small"
        valueClass="text-14-medium"
      />
    )
  }

  const empty = (text: string) => (
    <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
      <div class="text-14-regular text-text-weak max-w-56">{text}</div>
    </div>
  )

  const reviewEmptyText = createMemo(() => {
    if (store.changes === "git") return language.t("session.review.noUncommittedChanges")
    if (store.changes === "branch") return language.t("session.review.noBranchChanges")
    if (store.changes === "turn") return language.t("session.review.noChanges")
    return language.t(sessionEmptyKey())
  })

  const reviewEmpty = (input: { loadingClass: string; emptyClass: string }) => {
    if (store.changes === "git" || store.changes === "branch") {
      if (!reviewReady()) return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
      return empty(reviewEmptyText())
    }

    if (store.changes === "turn") {
      return empty(reviewEmptyText())
    }

    if (hasSessionReview() && !diffsReady()) {
      return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
    }

    if (sessionEmptyKey() === "session.review.noVcs") {
      return (
        <div class={input.emptyClass}>
          <div class="flex flex-col gap-3">
            <div class="text-14-medium text-text-strong">{language.t("session.review.noVcs.createGit.title")}</div>
            <div class="text-14-regular text-text-base max-w-md" style={{ "line-height": "var(--line-height-normal)" }}>
              {language.t("session.review.noVcs.createGit.description")}
            </div>
          </div>
          <Button size="large" disabled={gitMutation.isPending} onClick={initGit}>
            {gitMutation.isPending
              ? language.t("session.review.noVcs.createGit.actionLoading")
              : language.t("session.review.noVcs.createGit.action")}
          </Button>
        </div>
      )
    }

    return (
      <div class={input.emptyClass}>
        <div class="text-14-regular text-text-weak max-w-56">{reviewEmptyText()}</div>
      </div>
    )
  }

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Show when={true}>
      <SessionReviewTab
        title={changesTitle()}
        empty={reviewEmpty(input)}
        diffs={reviewDiffs}
        view={view}
        diffStyle={input.diffStyle}
        onDiffStyleChange={input.onDiffStyleChange}
        onScrollRef={(el) => setTree("reviewScroll", el)}
        focusedFile={tree.activeDiff}
        onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
        onLineCommentUpdate={updateCommentInContext}
        onLineCommentDelete={removeCommentFromContext}
        lineCommentActions={reviewCommentActions()}
        comments={comments.all()}
        focusedComment={comments.focus()}
        onFocusedCommentChange={comments.setFocus}
        onViewFile={openReviewFile}
        classes={input.classes}
      />
    </Show>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  createEffect(
    on(
      activeFileTab,
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    openReviewPanel()
    view().review.openPath(path)
    setTree({ activeDiff: path, pendingDiff: path })
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!reviewReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  createEffect(() => {
    const id = params.id
    if (!id) return

    if (!wantsReview()) return
    if (globalSync.session.diff.get(sdk.directory, id) !== undefined) return
    if (sync.status === "loading") return

    void sync.session.diff(id)
  })

  createEffect(
    on(
      () => [sessionKey(), wantsReview()] as const,
      ([key, wants]) => {
        if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
        if (diffTimer !== undefined) window.clearTimeout(diffTimer)
        diffFrame = undefined
        diffTimer = undefined
        if (!wants) return

        const id = params.id
        if (!id) return
        if (!untrack(() => globalSync.session.diff.get(sdk.directory, id) !== undefined)) return

        diffFrame = requestAnimationFrame(() => {
          diffFrame = undefined
          diffTimer = window.setTimeout(() => {
            diffTimer = undefined
            if (sessionKey() !== key) return
            void sync.session.diff(id, { force: true })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk.directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync.status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk.directory,
      () => {
        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const running = () => {
    const id = params.id
    if (!id) return false
    return working(sync.session.status.get(id), sync.data.message[id])
  }
  const autoScroll = createAutoScroll({
    working: running,
    overflowAnchor: "none",
    bottomThreshold: scrollBottomThreshold,
    resize: "off",
  })
  // Optimistic user turns land while session status is still idle, so running()
  // is false until the assistant message exists. Keep pinning across that gap.
  let followBottom = false
  const armFollowBottom = (source: string) => {
    if (!followBottom) {
      console.debug(`[session] follow-bottom arm source=${source}`)
    }
    followBottom = true
  }
  const clearFollowBottom = (source: string) => {
    if (!followBottom) return
    followBottom = false
    console.debug(`[session] follow-bottom clear source=${source}`)
  }
  const live = () => (running() || followBottom) && ui.mode === "live" && !autoScroll.userScrolled()
  const enterLive = () => {
    if (ui.mode === "live") return
    setUi("mode", "live")
  }
  const enterAnchored = () => {
    if (ui.mode === "anchored") return
    setUi("mode", "anchored")
  }

  const handleTimelineAutoScroll = (geometry: { scrollTop: number; scrollHeight: number; clientHeight: number }) => {
    autoScroll.handleScroll(geometry)
  }

  // Streaming stability depends on locking the outer timeline directly to the
  // physical bottom. This avoids relying on the auto-scroll state machine once
  // content height is already changing every frame.
  const lockBottom = (el: HTMLDivElement, source: string, mode: "auto" | "smooth" = "auto") => {
    const next = Math.max(0, el.scrollHeight - el.clientHeight)
    const dist = next - el.scrollTop
    if (Math.abs(dist) <= 1) {
      debug("lock-bottom:skip", el, { source, dist: Math.round(dist) })
      return
    }
    const ease =
      mode === "smooth" && shouldEaseLiveBottom(dist, { min: smoothBottomMinDistance, max: smoothBottomSnapDistance })
    if (ease) {
      const step = Math.sign(dist) * Math.min(Math.max(Math.abs(dist) * smoothBottomEase, 1), smoothBottomMaxStep)
      el.scrollTop += step
    } else {
      el.scrollTop = next
    }
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop
    console.debug(
      `[session] lock-bottom source=${source} mode=${mode} ease=${String(ease)} dist=${String(Math.round(dist))} gap=${String(Math.round(gap))} live=${String(live())}`,
    )
    debug("lock-bottom:write", el, { source, dist: Math.round(dist) })
  }

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let scrollStateGeometry: { scrollTop: number; scrollHeight: number; clientHeight: number } | undefined
  let contentResizeFrame: number | undefined
  let contentResizeTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined
  let initialScrollKey: string | undefined
  let initialScrollFrame: number | undefined
  let initialScrollStableFrames = 0
  let initialScrollHeight: number | undefined
  let initialScrollRevealUntil = 0
  let until = 0

  const hasScrollTarget = () => !!location.hash || !!ui.pendingMessage || !!ui.seekingMessageId || !!store.messageId
  const settling = () => !!initialScrollKey && performance.now() < until && !hasScrollGesture()
  const shouldPinBottom = () =>
    (followBottom || running() || settling() || live()) &&
    !autoScroll.userScrolled() &&
    !hasScrollGesture() &&
    !hasScrollTarget()

  const settle = (key: string) => {
    initialScrollFrame = undefined
    if (sessionKey() !== key) {
      initialScrollKey = undefined
      if (scroller) scroller.style.visibility = ""
      return
    }
    if (hasScrollTarget() || hasScrollGesture()) {
      initialScrollKey = undefined
      if (scroller) scroller.style.visibility = ""
      return
    }

    const root = scroller
    if (!root) {
      initialScrollKey = undefined
      return
    }

    lockBottom(root, "initial-scroll:settle")
    scheduleScrollState(root)

    const height = root.scrollHeight
    const gapAfter = Math.round(root.scrollHeight - root.clientHeight - root.scrollTop)
    if (Math.abs(gapAfter) <= 1 && height === initialScrollHeight) {
      initialScrollStableFrames += 1
    } else {
      initialScrollStableFrames = 0
    }
    initialScrollHeight = height
    // Do not reveal while virtual row measurements are still changing total height.
    if (
      root.style.visibility === "hidden" &&
      (initialScrollStableFrames >= 2 || performance.now() >= initialScrollRevealUntil)
    ) {
      root.style.visibility = ""
    }

    if (
      shouldFinishInitialScroll({ stableFrames: initialScrollStableFrames, now: performance.now(), deadline: until })
    ) {
      initialScrollKey = undefined
      if (root.style.visibility === "hidden") root.style.visibility = ""
      const id = params.id
      if (id) {
        markSessionProfile(
          id,
          "initial-scroll-settled",
          `frames=${String(initialScrollStableFrames)} gap=${String(gapAfter)} height=${String(height)}`,
        )
      }
      return
    }

    initialScrollFrame = requestAnimationFrame(() => settle(key))
  }

  const clamp = (el: HTMLDivElement, reason = "clamp") => {
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const top = Math.max(0, Math.min(el.scrollTop, max))
    if (Math.abs(el.scrollTop - top) <= 1) return top
    el.scrollTop = top
    return top
  }

  const reconcileContentResize = (root: HTMLDivElement) => {
    if (!root.isConnected || root !== scroller) return
    debug("content-resize:before", root)
    clamp(root, "content:resize:clamp")
    // ResizeObserver may deliver several row and total-size changes together.
    // Reconcile after those callbacks complete so this page-level follow logic
    // does not compete with the virtualizer in the same delivery cycle.
    if (shouldPinBottom()) {
      lockBottom(root, "content:resize:lock-bottom")
    }
    debug("content-resize:after", root)
    scheduleScrollState(root)
  }

  createResizeObserver(
    () => content,
    () => {
      const root = scroller
      if (!root) return
      contentResizeTarget = root
      if (contentResizeFrame !== undefined) return
      contentResizeFrame = requestAnimationFrame(() => {
        contentResizeFrame = undefined
        const target = contentResizeTarget
        contentResizeTarget = undefined
        if (target) reconcileContentResize(target)
      })
    },
  )

  let lastPinSkip = ""
  let lastPinSkipAt = 0
  const updateScrollState = (
    el: HTMLDivElement,
    geometry?: { scrollTop: number; scrollHeight: number; clientHeight: number },
  ) => {
    const clientHeight = geometry?.clientHeight ?? el.clientHeight
    const scrollHeight = geometry?.scrollHeight ?? el.scrollHeight
    if (!el.isConnected || clientHeight <= 0 || scrollHeight <= 0) return
    debug("state:before", el)
    if (shouldPinBottom()) {
      lastPinSkip = ""
      lockBottom(el, "state:live-lock")
    } else if (followBottom || running()) {
      const next = `running=${String(running())} follow=${String(followBottom)} live=${String(live())} userScrolled=${String(autoScroll.userScrolled())} gesture=${String(hasScrollGesture())} target=${String(hasScrollTarget())}`
      const now = performance.now()
      if (next !== lastPinSkip || now - lastPinSkipAt >= 5_000) {
        lastPinSkip = next
        lastPinSkipAt = now
        console.debug(
          `[session] pin-skip sid=${params.id ?? "none"} ${next} gap=${String(Math.round(el.scrollHeight - el.clientHeight - el.scrollTop))}`,
        )
      }
    } else {
      lastPinSkip = ""
    }
    const max = scrollHeight - clientHeight
    const top = geometry ? Math.max(0, Math.min(geometry.scrollTop, max)) : clamp(el)
    const overflow = max > 1
    const gap = max - top
    const bottom = !overflow || gap <= scrollBottomThreshold

    if ((live() || followBottom) && overflow && !bottom) {
      console.debug(
        `[session] scroll-state live-gap sid=${params.id ?? "none"} gap=${String(Math.round(gap))} overflow=${String(overflow)} bottom=${String(bottom)} follow=${String(followBottom)} running=${String(running())} virtual=${String(Math.round(content?.offsetHeight ?? 0))} scrollHeight=${String(Math.round(el.scrollHeight))}`,
      )
    }

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom) {
      debug("state:same", el, { nextOverflow: overflow, nextBottom: bottom })
      return
    }
    setUi("scroll", { overflow, bottom })
    console.debug(
      `[session] scroll-state update sid=${params.id ?? "none"} overflow=${String(overflow)} bottom=${String(bottom)} gap=${String(Math.round(gap))} live=${String(live())} follow=${String(followBottom)} running=${String(running())}`,
    )
    debug("state:update", el, { nextOverflow: overflow, nextBottom: bottom })
  }

  const scheduleScrollState = (
    el: HTMLDivElement,
    geometry?: { scrollTop: number; scrollHeight: number; clientHeight: number },
  ) => {
    scrollStateTarget = el
    scrollStateGeometry = geometry
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      const geometry = scrollStateGeometry
      scrollStateTarget = undefined
      scrollStateGeometry = undefined
      if (!target) return

      updateScrollState(target, geometry)
    })
  }

  const fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.clientHeight <= 0 || el.scrollHeight <= 0) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (!historyMore()) return

      console.debug(
        `[session] fill-trigger sid=${params.id} scrollHeight=${String(Math.round(el.scrollHeight))} clientHeight=${String(Math.round(el.clientHeight))} loaded=${String(messages().length)} visible=${String(visibleUserMessages().length)}`,
      )
      void loadEarlier()
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    setUi("seekingMessageId", undefined)
    clearMessageHash()
    enterLive()
    armFollowBottom("resume")
    autoScroll.resume()
    scrollToEnd()
    const el = scroller
    if (el) {
      lockBottom(el, "resume:jump")
      scheduleScrollState(el)
    }
    console.debug(
      `[session] resume-scroll live=${String(live())} follow=${String(followBottom)} running=${String(running())}`,
    )
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      () => [sessionKey(), messagesReady(), !!scroller] as const,
      ([key, ready, mounted]) => {
        if (!ready) return
        if (!mounted) return
        if (initialScrollKey === key) return
        initialScrollKey = key
        initialScrollStableFrames = 0
        initialScrollHeight = undefined
        initialScrollRevealUntil = performance.now() + initialScrollRevealMs
        const id = params.id
        if (id) markSessionProfile(id, "messages-ready")
        if (initialScrollFrame !== undefined) cancelAnimationFrame(initialScrollFrame)

        // Synchronously scroll to bottom before the browser paints to prevent
        // the visible flash of the conversation top on session entry.
        if (!hasScrollTarget() && scroller) {
          // Hide the scroller until scroll position is settled at the bottom.
          // Content renders with scrollTop=0 initially because windowing disables
          // during session switch, causing a visible flash of the middle content.
          scroller.style.visibility = "hidden"
          lockBottom(scroller, "initial-scroll:immediate")
        }

        initialScrollFrame = requestAnimationFrame(() => {
          initialScrollFrame = requestAnimationFrame(() => {
            initialScrollFrame = undefined
            if (sessionKey() !== key) {
              initialScrollKey = undefined
              if (scroller?.style.visibility === "hidden") scroller.style.visibility = ""
              return
            }
            if (hasScrollTarget()) {
              console.debug(
                `[session] initial bottom skipped: key=${key} hash=${location.hash || "none"} pending=${ui.pendingMessage || "none"} seeking=${ui.seekingMessageId || "none"} current=${store.messageId || "none"}`,
              )
              initialScrollKey = undefined
              if (scroller?.style.visibility === "hidden") scroller.style.visibility = ""
              return
            }
            const el = scroller
            if (!el) {
              initialScrollKey = undefined
              return
            }
            debug("initial:before", el, { key })
            setStore("messageId", undefined)
            enterLive()
            clearMessageHash()
            until = performance.now() + settleMs
            lockBottom(el, "initial-scroll:bottom")
            scheduleScrollState(el)
            debug("initial:after", el, { key })
            initialScrollFrame = requestAnimationFrame(() => settle(key))
          })
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        debug("user-scrolled:change", scroller, { scrolled })
        if (scrolled) {
          clearFollowBottom("user-scrolled")
          if (running()) enterAnchored()
          return
        }
        if (!running()) return
        enterLive()
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      running,
      (run) => {
        if (!run) return
        if (ui.seekingMessageId || store.messageId) return
        if (autoScroll.userScrolled()) {
          console.debug("[session] streaming follow skipped user-scrolled")
          return
        }
        console.debug("[session] streaming bottom follow enabled")
        armFollowBottom("running")
        enterLive()
        autoScroll.resume()
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => ui.scroll.bottom,
      (bottom, prev) => {
        debug("bottom:change", scroller, { prev, bottom })
        if (!bottom) return
        if (prev === undefined || prev === bottom) return
        if (ui.seekingMessageId) return
        if (!running()) {
          console.debug("[session] skip idle bottom resume")
          return
        }
        if (ui.mode !== "live") {
          enterLive()
          setStore("messageId", undefined)
          clearMessageHash()
        }
        if (!autoScroll.userScrolled()) return
        autoScroll.resume()
      },
      { defer: true },
    ),
  )

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    debug("scroll-ref", el)
    scheduleScrollState(el)
    fill()

    // The initial-scroll effect (below) depends on !!scroller, but scroller is
    // a plain variable — not reactive. If messagesReady() fired before the DOM
    // mounted, the effect exited early and never re-runs. Compensate here by
    // triggering the initial scroll when the ref arrives late.
    const key = sessionKey()
    if (key && messagesReady() && initialScrollKey !== key) {
      initialScrollKey = key
      initialScrollStableFrames = 0
      initialScrollHeight = undefined
      initialScrollRevealUntil = performance.now() + initialScrollRevealMs
      if (initialScrollFrame !== undefined) cancelAnimationFrame(initialScrollFrame)
      if (!hasScrollTarget()) {
        el.style.visibility = "hidden"
        lockBottom(el, "initial-scroll:ref-late")
      }
      until = performance.now() + settleMs
      initialScrollFrame = requestAnimationFrame(() => settle(key))
    }
  }

  const markUserScroll = () => {
    scrollMark += 1
    debug("user-scroll", scroller, { mark: scrollMark })
  }

  // One history page per "arrive at top" gesture. Re-arm only after the user leaves the edge,
  // so a failed scroll pin cannot chain-load the entire session while stuck at scrollTop≈0.
  const historyEdgePx = 200
  let historyLoadInFlight = false
  let historyEdgeArmed = true
  const prepareFindNavigation = () => {
    findNavigationUntil = performance.now() + 1_500
    historyEdgeArmed = false
    autoScroll.pause()
  }

  createEffect(
    on(
      () => params.id,
      () => {
        historyLoadInFlight = false
        historyEdgeArmed = true
      },
    ),
  )

  const loadEarlier = async () => {
    const id = params.id
    if (!id) return
    if (historyLoadInFlight || !historyMore() || historyLoading()) {
      console.debug(
        `[session] history-skip sid=${id} inFlight=${String(historyLoadInFlight)} more=${String(historyMore())} loading=${String(historyLoading())}`,
      )
      return
    }

    historyLoadInFlight = true
    historyEdgeArmed = false
    console.debug(
      `[session] history-start sid=${id} loaded=${String(messages().length)} visible=${String(visibleUserMessages().length)} more=${String(historyMore())}`,
    )
    const visibleBefore = visibleUserMessages().length
    historyAnchor.capture()
    try {
      while (true) {
        const loaded = messages().length
        await sync.session.history.loadMore(id)
        if (params.id !== id) return
        const nextLoaded = messages().length
        const visibleAfter = visibleUserMessages().length
        const result = historyPageResult({
          loaded,
          nextLoaded,
          visibleBefore,
          visibleAfter,
          more: historyMore(),
        })
        console.debug(
          `[session] history-page sid=${id} loaded=${String(loaded)} nextLoaded=${String(nextLoaded)} visible=${String(visibleBefore)}->${String(visibleAfter)} more=${String(historyMore())} result=${result}`,
        )
        const finished = result !== "continue"
        historyAnchor.restore(finished)
        if (finished) {
          console.debug(`[session] history-end sid=${id} finished=true loaded=${String(nextLoaded)}`)
          return
        }
      }
    } catch (error) {
      console.debug(`[session] history-error sid=${id} error=${error instanceof Error ? error.message : String(error)}`)
      historyAnchor.restore(true)
      throw error
    } finally {
      historyLoadInFlight = false
      console.debug(`[session] history-finally sid=${id} inFlight=false loaded=${String(messages().length)}`)
    }
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (!more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draftParts = (parts: Part[]) =>
    extractPromptFromParts(parts, {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })
  const draft = (id: string) => draftParts(sync.data.part[id] ?? [])

  const line = (id: string, input?: Part[]) => {
    const parts = input ?? sync.data.part[id] ?? []
    const command = commandInvocationFromParts(parts)
    if (command) {
      console.debug("[session] user message menu command", {
        messageID: id,
        command,
        partTypes: parts.map((part) => part.type),
      })
      return command
    }

    const text = draftParts(parts)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text

    // Synthetic injections (scheduled task / hook / slash command) are hidden from
    // extractPromptFromParts; surface their text so the menu does not fall back to "attachment".
    const injection = injectionPreviewFromParts(parts)
    if (injection) return injection

    return `[${language.t("common.attachment")}]`
  }
  const indexedUserMessages = createMemo(() => {
    const id = params.id
    if (!id) return undefined
    return sync.session.userMessageIndex.get(id)
  })
  const userMessageMenu = createMemo(() => {
    const indexed = indexedUserMessages()
    if (indexed) {
      const revert = revertMessageID()
      const indexedMessages = indexed.map((entry) => ({ id: entry.id, time: entry.time }))
      const boundary = revert
        ? (resolveMessage(messages(), revert) ?? resolveMessage(indexedMessages, revert))
        : undefined
      const entries = indexed
        .filter((entry) => !revert || (boundary ? compareMessages(entry, boundary) < 0 : entry.id < revert))
        .map((entry) => ({
          id: entry.id,
          text: entry.preview,
          created: entry.time.created,
        }))
      const known = new Set(entries.map((entry) => entry.id))
      for (const message of visibleUserMessages()) {
        if (known.has(message.id)) continue
        entries.push({ id: message.id, text: line(message.id), created: message.time.created })
      }
      return entries.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }
    return visibleUserMessages().map((message) => ({
      id: message.id,
      text: line(message.id),
      created: message.time.created,
    }))
  })

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const backgroundShell = async (input: {
    sessionID: string
    messageID?: string
    callID?: string
    jobId?: string
    command: string
    cwd?: string
    description?: string
  }) => {
    const currentSessionID = params.id
    console.info("[background-shell] request", {
      currentSessionID,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      jobId: input.jobId,
      command: input.command,
    })

    if (!currentSessionID || input.sessionID !== currentSessionID) {
      const error = new Error("Background shell belongs to a different session")
      console.warn("[background-shell] rejected session mismatch", {
        currentSessionID,
        sessionID: input.sessionID,
        jobId: input.jobId,
      })
      fail(error)
      throw error
    }
    if (!input.jobId) {
      const error = new Error("Background shell job is not available")
      console.warn("[background-shell] rejected missing job", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        callID: input.callID,
      })
      fail(error)
      throw error
    }

    try {
      const info = await setBackgroundShell({
        sdk,
        platform,
        auth: server.currentFor(domainFromDirectory(sdk.directory))?.http,
        id: input.jobId,
      })
      console.info("[background-shell] upgraded", {
        sessionID: input.sessionID,
        jobId: info.id,
        status: info.status,
        background: info.background,
      })
      showToast({
        variant: "success",
        title: "已设为背景 shell",
        description: input.description ?? input.command,
      })
    } catch (err) {
      console.error("[background-shell] upgrade failed", {
        sessionID: input.sessionID,
        jobId: input.jobId,
        error: err instanceof Error ? err.message : String(err),
      })
      fail(err)
      throw err
    }
  }

  const backgroundTask = async (input: {
    sessionID: string
    messageID?: string
    callID?: string
    childSessionID?: string
    description?: string
  }) => {
    const currentSessionID = params.id
    console.info("[background-task] request", {
      currentSessionID,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      childSessionID: input.childSessionID,
    })

    if (!currentSessionID || input.sessionID !== currentSessionID) {
      const error = new Error("Background task belongs to a different session")
      console.warn("[background-task] rejected session mismatch", {
        currentSessionID,
        sessionID: input.sessionID,
      })
      fail(error)
      throw error
    }

    try {
      const promoted = await backgroundSessionTasks({
        sdk,
        platform,
        auth: server.currentFor(domainFromDirectory(sdk.directory))?.http,
        sessionID: input.sessionID,
      })
      console.info("[background-task] result", {
        sessionID: input.sessionID,
        childSessionID: input.childSessionID,
        promoted,
      })
      if (!promoted) {
        // Server returns false when the experimental flag is off, or when the
        // running task was not registered as a BackgroundJob (e.g. started
        // before the flag was enabled). Surface a clear, non-OpenClaw message.
        const error = new Error(
          "没有可转为背景的前台子智能体。请重启桌面端（需开启 OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS），并在任务仍在前台运行时再试。",
        )
        fail(error)
        throw error
      }
      showToast({
        variant: "success",
        title: "已转为背景运行",
        description: input.description ?? input.childSessionID,
      })
    } catch (err) {
      console.error("[background-task] failed", {
        sessionID: input.sessionID,
        childSessionID: input.childSessionID,
        error: err instanceof Error ? err.message : String(err),
      })
      fail(err)
      throw err
    }
  }

  const merge = (next: NonNullable<ReturnType<typeof info>>) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === next.id)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = next
      return out
    })

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"]) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === sessionID)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = { ...out[idx], revert: next }
      return out
    })

  const busy = (sessionID: string) => {
    return working(sync.session.status.get(sessionID), sync.data.message[sessionID])
  }

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  const followupMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; id: string; manual?: boolean }) => {
      const item = (followup.items[input.sessionID] ?? []).find((entry) => entry.id === input.id)
      if (!item) return

      if (input.manual) setFollowup("paused", input.sessionID, undefined)
      setFollowup("failed", input.sessionID, undefined)

      const ok = await sendFollowupDraft({
        client: sdk.client,
        sync,
        globalSync,
        draft: item,
        optimisticBusy: item.sessionDirectory === sdk.directory,
      }).catch((err) => {
        setFollowup("failed", input.sessionID, input.id)
        fail(err)
        return false
      })
      if (!ok) return

      setFollowup("items", input.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== input.id))
      if (input.manual) resumeScroll()
    },
  }))

  const followupBusy = (sessionID: string) =>
    followupMutation.isPending && followupMutation.variables?.sessionID === sessionID

  const sendingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    if (!followupBusy(id)) return
    return followupMutation.variables?.id
  })

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    return settings.general.followup() === "queue" && busy(id) && !composer.blocked()
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() => queuedFollowups().map((item) => ({ id: item.id, text: followupText(item) })))

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followupBusy(sessionID)) return Promise.resolve()

    return followupMutation.mutateAsync({ sessionID, id, manual: opts?.manual })
  }

  const editFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
    })
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  const halt = (sessionID: string) =>
    busy(sessionID) ? sdk.client.session.abort({ sessionID }).catch(() => {}) : Promise.resolve()

  const revertMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; messageID: string }) => {
      const prev = prompt.current().slice()
      const last = info()?.revert
      const value = draft(input.messageID)
      batch(() => {
        roll(input.sessionID, { messageID: input.messageID })
        prompt.set(value)
      })
      await halt(input.sessionID)
        .then(() => sdk.client.session.revert(input))
        .then((result) => {
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(input.sessionID, last)
            prompt.set(prev)
          })
          fail(err)
        })
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      const sessionID = params.id
      if (!sessionID) return

      const current = resolveMessage(userMessages(), id)
      const next = current
        ? userMessages().find((item) => compareMessages(item, current) > 0)
        : userMessages().find((item) => item.id > id)
      const prev = prompt.current().slice()
      const last = info()?.revert

      batch(() => {
        roll(sessionID, next ? { messageID: next.id } : undefined)
        if (next) {
          prompt.set(draft(next.id))
          return
        }
        prompt.reset()
      })

      const task = !next
        ? halt(sessionID).then(() => sdk.client.session.unrevert({ sessionID }))
        : halt(sessionID).then(() =>
            sdk.client.session.revert({
              sessionID,
              messageID: next.id,
            }),
          )

      await task
        .then((result) => {
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(sessionID, last)
            prompt.set(prev)
          })
          fail(err)
        })
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending || restoreMutation.isPending)
  const restoring = createMemo(() => (restoreMutation.isPending ? restoreMutation.variables : undefined))

  const fork = (input: { sessionID: string; messageID: string }) => {
    const value = draft(input.messageID)
    const dir = base64Encode(sdk.directory)
    return sdk.client.session
      .fork(input)
      .then((result) => {
        const next = result.data
        if (!next) {
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
          })
          return
        }
        prompt.set(value, undefined, { dir, id: next.id })
        navigate(`/${dir}/session/${next.id}`)
      })
      .catch(fail)
  }

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    return revertMutation.mutateAsync(input)
  }

  const restore = (id: string) => {
    if (!params.id || reverting()) return
    return restoreMutation.mutateAsync(id)
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    const boundary = resolveMessage(userMessages(), id) ?? resolveMessage(messages(), id)
    if (!boundary) return []
    return userMessages()
      .filter((item) => compareMessages(item, boundary) >= 0)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  const actions = { fork, revert }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    const item = queuedFollowups()[0]
    if (!item) return
    if (followupBusy(sessionID)) return
    if (followup.failed[sessionID] === item.id) return
    if (followup.paused[sessionID]) return
    if (composer.blocked()) return
    if (busy(sessionID)) return

    void sendFollowup(sessionID, item.id)
  })

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const gap = el ? el.scrollHeight - el.clientHeight - el.scrollTop : 0
      const stick =
        el && !ui.seekingMessageId && running()
          ? !autoScroll.userScrolled() || gap <= scrollBottomThreshold + Math.max(0, delta)
          : false

      dockHeight = next

      if (el && stick) {
        requestAnimationFrame(() => {
          if (scroller !== el) return
          const top = el.scrollHeight - el.clientHeight - gap
          el.scrollTop = top > 0 ? top : 0
          clamp(el, "dock:resize:clamp")
        })
      }

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    directory: () => sdk.directory,
    messagesReady,
    live,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: () => loadEarlier(),
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setSeekingMessage: (value) => setUi("seekingMessageId", value),
    setActiveMessage,
    enterLive,
    enterAnchored,
    autoScroll,
    prepareNavigation: () => prepareMessageNavigation(),
    scroller: () => scroller,
    anchor,
    revealMessage: (id) => revealMessage(id),
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  onCleanup(() => {
    refreshRun += 1
    document.removeEventListener("keydown", handleKeyDown)
    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
    if (diffTimer !== undefined) window.clearTimeout(diffTimer)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (contentResizeFrame !== undefined) cancelAnimationFrame(contentResizeFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
    if (initialScrollFrame !== undefined) cancelAnimationFrame(initialScrollFrame)
    if (scroller?.style.visibility === "hidden") scroller.style.visibility = ""
  })

  return (
    <div
      ref={(el) => {
        root = el
      }}
      onClick={handleFileLinkClick}
      class="relative bg-background-stronger size-full overflow-hidden flex flex-col"
    >
      <SessionHeader />
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        <Show when={!isDesktop() && !!params.id}>
          <Tabs value={store.mobileTab} class="h-auto">
            <Tabs.List>
              <Tabs.Trigger
                value="session"
                class="!w-1/2 !max-w-none"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "session")}
              >
                {language.t("session.tab.session")}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="changes"
                class="!w-1/2 !max-w-none !border-r-0"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "changes")}
              >
                {hasReview()
                  ? language.t("session.review.filesChanged", { count: reviewCount() })
                  : language.t("session.review.change.other")}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </Show>

        {/* Session panel */}
        <div
          classList={{
            "@container relative shrink-0 flex flex-col min-h-0 h-full bg-background-stronger flex-1 md:flex-none": true,
            "will-change-[width]": !size.active() && !ui.reviewSnap,
          }}
          style={{
            width: sessionPanelWidth(),
            transition: size.active() || ui.reviewSnap ? undefined : "width 300ms cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <div class="relative flex-1 min-h-0">
            <div class="absolute inset-0 overflow-hidden">
              <Switch>
                <Match when={params.id}>
                  <Show
                    when={messagesReady() ? sessionKey() : false}
                    keyed
                    fallback={<div class="size-full bg-background-stronger" />}
                  >
                    <Show
                      when={!mobileChanges()}
                      fallback={
                        <div class="relative h-full overflow-hidden">
                          {reviewContent({
                            diffStyle: "unified",
                            classes: { root: "pb-8", header: "px-4", container: "px-4" },
                            loadingClass: "px-4 py-4 text-text-weak",
                            emptyClass:
                              "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
                          })}
                        </div>
                      }
                    >
                      <MessageTimeline
                        actions={actions}
                        onBackgroundShell={backgroundShell}
                        onBackgroundTask={backgroundTask}
                        scroll={ui.scroll}
                        onResumeScroll={resumeScroll}
                        setScrollRef={setScrollRef}
                        onScheduleScrollState={scheduleScrollState}
                        onAutoScrollHandleScroll={handleTimelineAutoScroll}
                        onMarkScrollGesture={markScrollGesture}
                        hasScrollGesture={hasScrollGesture}
                        onUserScroll={markUserScroll}
                        onFindNavigate={prepareFindNavigation}
                        onHistoryScroll={(scrollTop) => {
                          if (!autoScroll.userScrolled() || !scroller) return
                          if (performance.now() < findNavigationUntil) return
                          if (scrollTop >= historyEdgePx) {
                            historyEdgeArmed = true
                            return
                          }
                          if (!historyEdgeArmed || historyLoadInFlight) return
                          void loadEarlier()
                        }}
                        onAutoScrollInteraction={autoScroll.handleInteraction}
                        shouldAnchorBottom={() => !hasScrollTarget() && !autoScroll.userScrolled()}
                        isInitialScrollSettling={settling}
                        centered={centered()}
                        setContentRef={(el) => {
                          content = el
                          autoScroll.contentRef(el)

                          const root = scroller
                          if (root) scheduleScrollState(root)
                        }}
                        userMessages={visibleUserMessages()}
                        anchor={anchor}
                        setRevealMessage={(fn) => {
                          revealMessage = fn
                        }}
                        setPrepareNavigation={(fn) => {
                          prepareMessageNavigation = fn
                        }}
                        setScrollToEnd={(fn) => {
                          scrollToEnd = fn
                        }}
                        setHistoryAnchor={(handlers) => {
                          historyAnchor = handlers
                        }}
                        onRenderOverlayStatusChange={(status) => setUi("renderOverlayStatus", status)}
                      />
                    </Show>
                  </Show>
                </Match>
                <Match when={true}>
                  <NewSessionView
                    worktree={newSessionWorktree()}
                    onWorktreeChange={(value) => {
                      setStore("newSessionWorktree", value)
                      setStore("newSessionPicked", true)
                    }}
                  />
                </Match>
              </Switch>
            </div>
            <Show when={platform.platform === "desktop" && params.id}>
              <SessionStatusFloat
                sessionID={params.id}
                skills={activeSkills()}
                diffs={diffs()}
                childSessionIDs={currentApiChildSessions().map((session) => session.id)}
              />
            </Show>
            {/* Always show on desktop session routes (including new session) so users can
                mount a project task before the first message creates the session. */}
            <Show when={platform.platform === "desktop"}>
              <SessionTodoFloat
                sessionID={params.id}
                todos={composer.todos()}
                collapseLabel={language.t("session.todo.collapse")}
                expandLabel={language.t("session.todo.expand")}
              />
            </Show>
            <Show when={platform.platform === "desktop"}>
              <SessionMathFloat
                available={mathModeAvailable()}
                initializing={mathModeInitializing()}
                workers={mathWorkerEntries()}
                busy={mathWorkersBusy()}
                onInitialize={openMathInitialize}
                onOpen={openMathWorker}
                onOpenWorkerSession={openMathWorkerSession}
                onDetails={(kind, offset) => {
                  const parentSessionID = params.id
                  const project = mathSwarm.workers[0]?.project
                  if (!parentSessionID || !project) return Promise.reject(new Error("Math Mode project is unavailable"))
                  return listMathDetails({
                    sdk,
                    platform,
                    auth: server.currentFor(domainFromDirectory(sdk.directory))?.http,
                    parentSessionID,
                    project,
                    kind,
                    offset,
                    limit: 20,
                  })
                }}
                onEnsure={(entry) => void ensureMathWorker(entry)}
                onReEnable={(entry) => void ensureMathWorker(entry, true)}
                onStop={(entry) => void stopMathWorker(entry)}
                onTask={(entry) => void editMathWorkerTask(entry)}
                defaultVerifierModel={
                  local.model.current() ? `${local.model.current()!.provider.id}/${local.model.current()!.id}` : ""
                }
                onVerifierModelChange={updateVerifierModel}
              />
            </Show>
          </div>

          <SessionComposerRegion
            state={composer}
            ready={messagesReady()}
            centered={centered()}
            inputRef={(el) => {
              inputRef = el
            }}
            newSessionWorktree={newSessionWorktree()}
            onNewSessionWorktreeReset={() => {
              setStore("newSessionWorktree", "main")
              setStore("newSessionPicked", false)
            }}
            onSubmit={(sessionID) => {
              if (mathMode.prepared) {
                console.debug(`[math-initialize] submit dispatched session=${sessionID}`)
                setMathMode("initializingSessionID", sessionID)
              }
              comments.clear()
              resumeScroll()
            }}
            onSubmitFailed={(sessionID) => {
              if (mathMode.initializingSessionID !== sessionID) return
              console.debug(`[math-initialize] clear pending session=${sessionID} reason=send-failed`)
              setMathMode({ prepared: false, initializingSessionID: undefined })
            }}
            onSubmitted={() => {
              resumeScroll()
            }}
            onAbort={stopCurrentMathWorkerOnAbort}
            onResponseSubmit={resumeScroll}
            onScrollToBottom={resumeScroll}
            scrollState={ui.scroll}
            followup={
              params.id
                ? {
                    queue: queueEnabled,
                    items: followupDock(),
                    sending: sendingFollowup(),
                    edit: editingFollowup(),
                    onQueue: queueFollowup,
                    onAbort: () => {
                      const id = params.id
                      if (!id) return
                      setFollowup("paused", id, true)
                    },
                    onSend: (id) => {
                      void sendFollowup(params.id!, id, { manual: true })
                    },
                    onEdit: editFollowup,
                    onEditLoaded: clearFollowupEdit,
                  }
                : undefined
            }
            revert={
              rolled().length > 0
                ? {
                    items: rolled(),
                    restoring: restoring(),
                    disabled: reverting(),
                    onRestore: restore,
                  }
                : undefined
            }
            childAgents={childAgentEntries()}
            onOpenChildAgent={openChildAgent}
            userMessages={userMessageMenu()}
            userMessagesLoading={params.id ? sync.session.userMessageIndex.loading(params.id) : false}
            userMessagesComplete={
              indexedUserMessages() !== undefined || !!(params.id && sync.session.userMessageIndex.failed(params.id))
            }
            userMessageCount={userMessageMenu().length}
            onOpenUserMessage={(entry) => {
              const loaded = visibleUserMessages().find((item) => item.id === entry.id)
              const indexed = indexedUserMessages()?.find((item) => item.id === entry.id)
              console.debug(
                `[user-message-menu] select sid=${params.id ?? "none"} id=${entry.id} found=${String(!!loaded || !!indexed)} loaded=${String(!!loaded)} shown=${String(messages().length)} users=${String(visibleUserMessages().length)}`,
              )
              if (loaded) {
                scrollToMessage(loaded, "auto")
                return
              }
              if (!indexed) return
              setUi("pendingMessage", indexed.id)
              prepareFindNavigation()
            }}
            subagentNavigation={subagentNavigation()}
            subagentTitle={subagentPromptTitle()}
            mathModeActive={mathModeAgentLocked()}
            setPromptDockRef={(el) => {
              promptDock = el
            }}
          />

          <Show when={sessionRenderOverlayStatus() !== "hidden"}>
            <div
              data-slot="session-render-overlay"
              aria-live="polite"
              aria-busy={sessionRenderOverlayStatus() === "showing" ? "true" : "false"}
              class="absolute inset-0 z-[70] flex items-center justify-center"
              classList={{
                "opacity-100 pointer-events-auto": sessionRenderOverlayStatus() === "showing",
                "opacity-0 pointer-events-none transition-opacity duration-200 ease-out":
                  sessionRenderOverlayStatus() === "hiding",
              }}
              style={{
                background: "var(--background-stronger)",
              }}
            >
              <div class="flex items-center gap-2 rounded-full border border-border-weak-base bg-background-stronger px-3 py-2 text-12-medium text-text-weak shadow-sm">
                <Spinner class="size-4" />
                <span>{language.t("session.messages.loading")}</span>
              </div>
            </div>
          </Show>

          <Show when={desktopReviewOpen() || desktopFilePreviewOpen()}>
            <div onPointerDown={() => size.start()}>
              <ResizeHandle
                direction="horizontal"
                size={layout.session.width()}
                min={450}
                max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.45}
                onResize={(width) => {
                  size.touch()
                  layout.session.resize(width)
                }}
              />
            </div>
          </Show>
        </div>

        <SessionSidePanel
          canReview={canReview}
          diffs={reviewDiffs}
          diffsReady={reviewReady}
          empty={reviewEmptyText}
          hasReview={hasReview}
          reviewCount={reviewCount}
          reviewPanel={reviewPanel}
          activeDiff={tree.activeDiff}
          focusReviewDiff={focusReviewDiff}
          reviewSnap={ui.reviewSnap}
          size={size}
        />
      </div>

      <TerminalPanel />
    </div>
  )
}
