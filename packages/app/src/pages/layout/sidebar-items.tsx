import type { Session } from "@opencode-ai/sdk/v2/client"
import { Avatar } from "@opencode-ai/ui/avatar"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Keybind } from "@opencode-ai/ui/keybind"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { A, useParams } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useCommand } from "@/context/command"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { getAvatarColors, type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { messageAgentColor } from "@/utils/agent"
import { ensureSessionProfile, startSessionProfile } from "@/utils/session-profile"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { working } from "../session/session-working"
import {
  hasProjectPermissions,
  isInitialSessionLoad,
  isScheduledSessionTitle,
  stripScheduledSessionTitle,
  workingSessionTreeIDs,
  workspaceKey,
} from "./helpers"

const OPENCODE_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"
const projectActivityPulseInterval = 6_000
const projectActivityPulseDuration = 1_000

/** Module-level so title shimmer survives SessionItem remount after title update. */
const titleShimmerTimers = new Map<string, ReturnType<typeof setTimeout>>()
const [titleShimmerById, setTitleShimmerById] = createSignal<Record<string, boolean>>({})

const isTitleShimmering = (sessionID: string) => !!titleShimmerById()[sessionID]

const SHIMMER_STYLE_ID = "opencode-session-title-shimmer-style"
const ensureSessionTitleShimmerKeyframes = () => {
  if (typeof document === "undefined") return
  if (document.getElementById(SHIMMER_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = SHIMMER_STYLE_ID
  style.textContent = `
@keyframes session-title-text-shimmer {
  0% { background-position: 100% center, 0 0; }
  100% { background-position: -100% center, 0 0; }
}
`
  document.head.appendChild(style)
}

const setTitleShimmering = (sessionID: string, active: boolean) => {
  setTitleShimmerById((prev) => {
    if (!!prev[sessionID] === active) return prev
    if (active) return { ...prev, [sessionID]: true }
    const next = { ...prev }
    delete next[sessionID]
    return next
  })
}

const clearTitleShimmer = (sessionID: string) => {
  const timer = titleShimmerTimers.get(sessionID)
  if (timer !== undefined) {
    clearTimeout(timer)
    titleShimmerTimers.delete(sessionID)
  }
  setTitleShimmering(sessionID, false)
}

const pulseTitleShimmer = (sessionID: string, ms = 3600) => {
  const existing = titleShimmerTimers.get(sessionID)
  if (existing !== undefined) clearTimeout(existing)
  setTitleShimmering(sessionID, true)
  titleShimmerTimers.set(
    sessionID,
    setTimeout(() => {
      titleShimmerTimers.delete(sessionID)
      setTitleShimmering(sessionID, false)
    }, ms),
  )
}


export const ProjectIcon = (props: { project: LocalProject; class?: string; notify?: boolean }): JSX.Element | null => {
  if (!props.project?.worktree) return null
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const permission = usePermission()
  const dirs = createMemo(() => [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const stores = createMemo(() => dirs().map((directory) => globalSync.child(directory, { bootstrap: false })[0]))
  const loaded = createMemo(() => dirs().some((directory) => globalSync.loaded(directory)))
  const loadingSessions = createMemo(() => isInitialSessionLoad(stores()))
  const hasActiveSession = createMemo(() =>
    dirs().some((directory) => {
      const [store] = globalSync.child(directory, { bootstrap: false })
      return store.session.some((session) =>
        working(globalSync.session.status.get(directory, session.id), store.message[session.id]),
      )
    }),
  )
  const [activityPulse, setActivityPulse] = createSignal(false)
  createEffect(() => {
    if (!hasActiveSession()) {
      setActivityPulse(false)
      return
    }

    let frame: number | undefined
    let stop: number | undefined
    const pulse = () => {
      setActivityPulse(false)
      frame = window.requestAnimationFrame(() => {
        setActivityPulse(true)
        stop = window.setTimeout(() => setActivityPulse(false), projectActivityPulseDuration)
      })
    }
    pulse()
    const timer = window.setInterval(pulse, projectActivityPulseInterval)
    onCleanup(() => {
      window.clearInterval(timer)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      if (stop !== undefined) window.clearTimeout(stop)
    })
  })
  // Session-status full-table refresh is boundary-only (bootstrap / reconnect / long
  // visibility restore) in global-sync — not polled while the project has active work.
  const count = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const unseenSummary = createMemo(() =>
    dirs()
      .flatMap((directory) =>
        notification.project.unseen(directory).map((item) => {
          return `${directory}:${item.type}:${item.session ?? "none"}:viewed=${item.viewed ? 1 : 0}`
        }),
      )
      .join("|") || "none",
  )
  const error = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const perms = createMemo(() =>
    dirs().some((directory) => {
      const [store] = globalSync.child(directory, { bootstrap: false })
      return hasProjectPermissions(store.session, store.permission, directory, (item) => {
        return !permission.autoResponds(item, directory)
      })
    }),
  )
  const notify = createMemo(() => props.notify && (perms() || count() > 0))
  const badge = createMemo(() => {
    if (perms()) return { kind: "permission", label: "!" }
    if (error()) return { kind: "error", label: "!" }
    const value = count()
    return { kind: "message", label: value > 99 ? "99+" : `${value}` }
  })
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))
  let last = ""
  createEffect(() => {
    if (!props.notify) return
    const next = `${count()}:${error()}:${perms()}:${unseenSummary()}`
    if (next === last) return
    last = next
    console.debug(
      `[project-icon] inspect root=${props.project.worktree} dirs=${dirs().join(",") || "none"} count=${count()} error=${error() ? 1 : 0} permission=${perms() ? 1 : 0} unseen=${unseenSummary()}`,
    )
  })
  return (
    <div
      data-loaded={loaded() ? "true" : "false"}
      data-component={loadingSessions() ? "project-icon-loading" : undefined}
      class={`relative size-8 shrink-0 ${props.class ?? ""}`}
    >
      <div data-slot="project-avatar-clip" class="size-full rounded-full overflow-clip">
        <Avatar
          fallback={name()}
          src={
            loaded() && props.project.id === OPENCODE_PROJECT_ID
              ? "https://opencode.ai/favicon.svg"
              : loaded()
                ? props.project.icon?.override
                : undefined
          }
          {...(loaded()
            ? getAvatarColors(props.project.icon?.color)
            : {
                background: "var(--color-surface-base-hover)",
                foreground: "var(--color-text-weak)",
              })}
          class="size-full rounded-full"
        />
      </div>
      <Show when={loadingSessions()}>
        <div data-slot="sheen" class="pointer-events-none absolute inset-0 z-[5]" />
      </Show>
      <Show when={hasActiveSession()}>
        <div
          data-component="project-activity-badge"
          aria-hidden="true"
          class="pointer-events-none absolute -bottom-0.5 -right-0.5 z-10 flex size-3"
        >
          <Show when={activityPulse()}>
            <span data-slot="project-activity-ripple" class="absolute inline-flex h-full w-full rounded-full" />
          </Show>
          <span data-slot="project-activity-dot" class="relative inline-flex size-3 rounded-full" />
        </div>
      </Show>
      <Show when={notify()}>
        <div
          data-component="project-notification-badge"
          data-kind={badge().kind}
          aria-hidden="true"
          class="absolute -top-1 -right-1 z-10 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none"
          classList={{
            "bg-surface-warning-strong text-white": badge().kind === "permission",
            "bg-text-diff-delete-base text-white": badge().kind === "error",
            "bg-surface-success-base text-text-on-success-base": badge().kind === "message",
          }}
        >
          {badge().label}
        </div>
      </Show>
    </div>
  )
}

type SessionInlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  root?: string
  mobile?: boolean
  dense?: boolean
  reduced?: boolean
  sidebarExpanded: Accessor<boolean>
  pendingSelection: Accessor<{ directory: string; id: string } | undefined>
  selectSession: (session: Session) => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
  editorOpen: (id: string) => boolean
  openEditor: (id: string, value: string) => void
  InlineEditor: SessionInlineEditorComponent
}

const isPlainPrimaryMouse = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

const isPlainPrimaryPointer = (event: PointerEvent) => event.isPrimary && isPlainPrimaryMouse(event)

const SessionRow = (props: {
  session: Session
  mobile?: boolean
  dense?: boolean
  active?: boolean
  tint: Accessor<string | undefined>
  isWorking: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  hasError: Accessor<boolean>
  unseenCount: Accessor<number>
  sidebarOpened: Accessor<boolean>
  select: () => void
  warmHover: () => void
  warmPress: () => void
  warmFocus: () => void
  cancelHoverPrefetch: () => void
  detail?: Accessor<boolean | undefined>
  reduced?: boolean
  shimmer: Accessor<boolean>
  editingTitle: Accessor<boolean>
  InlineEditor: SessionInlineEditorComponent
  renameSession: (next: string) => void
}): JSX.Element => {
  const scheduled = createMemo(() => isScheduledSessionTitle(props.session.title))
  const displayTitle = createMemo(() => stripScheduledSessionTitle(props.session.title))
  const shimmering = createMemo(() => props.shimmer())
  let titleEl: HTMLSpanElement | undefined

  const applyTitleShimmerStyle = (el: HTMLSpanElement | undefined, active: boolean, selected: boolean) => {
    if (!el) return
    ensureSessionTitleShimmerKeyframes()
    if (!active) {
      el.style.color = selected ? "var(--sidebar-session-accent)" : ""
      el.style.removeProperty("-webkit-text-fill-color")
      el.style.removeProperty("background-image")
      el.style.removeProperty("background-size")
      el.style.removeProperty("background-repeat")
      el.style.removeProperty("background-position")
      el.style.removeProperty("-webkit-background-clip")
      el.style.removeProperty("background-clip")
      el.style.removeProperty("animation")
      el.style.removeProperty("will-change")
      return
    }
    // Dual-layer fill (same idea as TextShimmer):
    // 1) muted solid base keeps glyphs always readable
    // 2) brighter peak band sweeps slowly for high-contrast motion
    const base = selected
      ? "color-mix(in srgb, var(--sidebar-session-accent) 55%, var(--text-weak))"
      : "var(--text-weak)"
    const peak = selected
      ? "color-mix(in srgb, var(--sidebar-session-accent) 15%, var(--text-strong))"
      : "var(--text-strong)"
    el.style.setProperty("color", "transparent")
    el.style.setProperty("-webkit-text-fill-color", "transparent")
    el.style.setProperty(
      "background-image",
      [
        `linear-gradient(90deg, transparent 0%, transparent 46%, ${peak} 50%, transparent 54%, transparent 100%)`,
        `linear-gradient(${base}, ${base})`,
      ].join(", "),
    )
    el.style.setProperty("background-size", "260% 100%, 100% 100%")
    el.style.setProperty("background-repeat", "no-repeat, no-repeat")
    el.style.setProperty("background-position", "100% center, 0 0")
    el.style.setProperty("-webkit-background-clip", "text")
    el.style.setProperty("background-clip", "text")
    el.style.setProperty("will-change", "background-position")
    el.style.animation = "none"
    void el.offsetWidth
    el.style.animation = "session-title-text-shimmer 2.8s linear infinite"
  }

  createEffect(() => {
    applyTitleShimmerStyle(titleEl, shimmering(), !!props.active)
  })

  return (
    <A
      href={`/${base64Encode(props.session.directory)}/session/${props.session.id}`}
      class={`flex items-center gap-1 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onPointerDown={(event) => {
        if (isPlainPrimaryPointer(event)) {
          startSessionProfile(props.session.id, "pointerdown")
          props.select()
        }
        props.warmPress()
      }}
      onFocus={props.warmFocus}
      onClick={(event) => {
        if (isPlainPrimaryMouse(event)) {
          ensureSessionProfile(props.session.id, "click")
          props.select()
        }
        if (props.sidebarOpened()) return
      }}
    >
      <div class="flex items-center gap-1 w-full">
        <Show when={props.isWorking() || props.hasPermissions() || props.hasError() || props.unseenCount() > 0}>
          <div
            class="shrink-0 size-6 flex items-center justify-center"
            style={{
              color: props.active ? "var(--sidebar-session-accent)" : (props.tint() ?? "var(--icon-interactive-base)"),
            }}
          >
            <Switch>
              <Match when={props.isWorking()}>
                <Spinner class="size-[15px]" />
              </Match>
              <Match when={props.hasPermissions()}>
                <div class="size-1.5 rounded-full bg-surface-warning-strong" />
              </Match>
              <Match when={props.hasError()}>
                <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
              </Match>
              <Match when={props.unseenCount() > 0}>
                <div class="size-1.5 rounded-full bg-text-interactive-base" />
              </Match>
            </Switch>
          </div>
        </Show>
        <Show when={scheduled()}>
          <Icon
            name="clock"
            size="small"
            class="shrink-0 text-icon-weak"
            style={props.active ? { color: "var(--sidebar-session-accent)" } : undefined}
          />
        </Show>
        <Show
          when={props.editingTitle()}
          fallback={
            <span
              ref={(el) => {
                titleEl = el
                applyTitleShimmerStyle(el, shimmering(), !!props.active)
              }}
              data-slot="session-title"
              data-shimmer={shimmering() ? "true" : "false"}
              classList={{
                "text-16-medium grow-1 min-w-0 overflow-hidden text-ellipsis truncate": true,
                "transition-colors": !props.reduced && !shimmering(),
                "text-text-base": !props.active && !shimmering(),
              }}
            >
              {displayTitle()}
            </span>
          }
        >
          <props.InlineEditor
            id={`session:${props.session.id}`}
            value={displayTitle}
            onSave={props.renameSession}
            class="text-16-medium grow-1 min-w-0 w-full bg-transparent outline-none border-none p-0"
            displayClass="text-16-medium grow-1 min-w-0 overflow-hidden text-ellipsis truncate"
            editing
            stopPropagation
            openOnDblClick={false}
          />
        </Show>
      </div>
    </A>
  )
}


export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const layout = useLayout()
  const language = useLanguage()
  const command = useCommand()
  const notification = useNotification()
  const permission = usePermission()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const [menu, setMenu] = createStore({ pendingRename: false, copied: false })
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  // Keep module shimmer signal subscribed at SessionItem level so remounts still animate.
  const titleShimmer = createMemo(() => isTitleShimmering(props.session.id))
  const editingTitle = createMemo(() => props.editorOpen(`session:${props.session.id}`))
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore] = globalSync.child(props.session.directory, { bootstrap: false })
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
      return !permission.autoResponds(item, props.session.directory)
    })
  })
  const activeSessionIDs = createMemo(() =>
    workingSessionTreeIDs({
      sessionID: props.session.id,
      sessions: sessionStore.session,
      statuses: sessionStore.session_status,
      messages: sessionStore.message,
    }),
  )
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    return activeSessionIDs().length > 0
  })
  let loggedActivity = ""
  createEffect(() => {
    const ids = activeSessionIDs()
    const next = ids.join(",")
    if (next === loggedActivity) return
    loggedActivity = next
    console.debug(
      `[sidebar-session] activity id=${props.session.id} active=${ids.length > 0 ? "true" : "false"} sessions=${next || "none"}`,
    )
  })
  let loggedNotification = ""
  createEffect(() => {
    const unseen = notification.session.unseen(props.session.id)
    const next = unseen
      .map((item) => `${item.type}:${item.directory ?? "none"}:viewed=${item.viewed ? 1 : 0}`)
      .join("|")
    if (next === loggedNotification) return
    loggedNotification = next
    console.debug(
      `[sidebar-session] notifications id=${props.session.id} directory=${props.session.directory} unseen=${unseen.length} entries=${next || "none"}`,
    )
  })
  const isActive = createMemo(() => props.session.id === params.id)
  const isSelected = createMemo(() => {
    if (isActive()) return true
    const pending = props.pendingSelection()
    if (!pending) return false
    return pending.id === props.session.id && workspaceKey(pending.directory) === workspaceKey(props.session.directory)
  })
  const detail = createMemo(() => {
    if (!props.root) return
    return workspaceKey(props.session.directory) !== workspaceKey(props.root)
  })

  const tint = createMemo(() => {
    return messageAgentColor(sessionStore.message[props.session.id], sessionStore.agent)
  })

  const hoverAllowed = createMemo(() => !props.mobile && props.sidebarExpanded())
  const hoverEnabled = createMemo(() => hoverAllowed())
  const tooltip = createMemo(() => !props.reduced && (props.mobile || !props.sidebarExpanded()))
  const jumpIndex = createMemo(() => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list
    const index = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (index < 0 || index > 4) return
    return index + 1
  })
  const jumpKeybind = createMemo(() => {
    const index = jumpIndex()
    if (!index) return
    return command.keybind(`session.jump.${index}`)
  })
  const copy = () => {
    const text = `Session ID: ${props.session.id}\nProject path: ${props.session.directory}`
    const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard
    console.debug(`[sidebar-session] copy info id=${props.session.id} dir=${props.session.directory}`)
    if (!clip?.writeText) {
      console.debug(`[sidebar-session] clipboard unavailable id=${props.session.id}`)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: "Clipboard unavailable",
      })
      return
    }
    void clip.writeText(text).then(
      () => {
        console.debug(`[sidebar-session] copied info id=${props.session.id} dir=${props.session.directory}`)
        setMenu("copied", true)
        if (copiedTimer) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => setMenu("copied", false), 1_200)
      },
      (err: unknown) => {
        console.debug(`[sidebar-session] copy failed id=${props.session.id} err=${err instanceof Error ? err.message : String(err)}`)
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      },
    )
  }

  const generateTitle = () => {
    pulseTitleShimmer(props.session.id, 60_000)
    const [, setSessionStore] = globalSync.child(props.session.directory, { bootstrap: false })
    void globalSDK.client.session
      .generateTitle(
        {
          sessionID: props.session.id,
          directory: props.session.directory,
        },
        { throwOnError: true },
      )
      .then(
        (result) => {
          const data =
            result && typeof result === "object" && "data" in result
              ? (result as { data?: Session }).data
              : (result as Session | undefined)
          if (data?.title) {
            setSessionStore("session", (list) =>
              list.map((item) => (item.id === props.session.id ? { ...item, title: data.title } : item)),
            )
          }
          pulseTitleShimmer(props.session.id, 3600)
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("toast.session.generateTitle.success.title"),
            description: data?.title,
          })
        },
        (err: unknown) => {
          clearTitleShimmer(props.session.id)
          const message =
            err instanceof Error
              ? err.message
              : typeof err === "object" && err && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err)
          showToast({
            variant: "error",
            title: language.t("toast.session.generateTitle.failed.title"),
            description: message,
          })
        },
      )
  }

  const renameSession = (next: string) => {
    const trimmed = next.trim()
    if (!trimmed) return
    const current = stripScheduledSessionTitle(props.session.title)
    if (trimmed === current) return
    const [, setSessionStore] = globalSync.child(props.session.directory, { bootstrap: false })
    console.debug(`[sidebar-session] rename start id=${props.session.id} dir=${props.session.directory}`)
    void globalSDK.client.session
      .update(
        {
          sessionID: props.session.id,
          directory: props.session.directory,
          title: trimmed,
        },
        { throwOnError: true },
      )
      .then(
        () => {
          setSessionStore("session", (list) =>
            list.map((item) => (item.id === props.session.id ? { ...item, title: trimmed } : item)),
          )
          console.debug(`[sidebar-session] renamed id=${props.session.id}`)
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("common.rename"),
            description: trimmed,
          })
        },
        (err: unknown) => {
          const message =
            err instanceof Error
              ? err.message
              : typeof err === "object" && err && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err)
          console.debug(`[sidebar-session] rename failed id=${props.session.id} err=${message}`)
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: message,
          })
        },
      )
  }

  const warm = (priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    const next = list[idx + 1]
    if (next) props.prefetchSession(next, priority)
    const prev = list[idx - 1]
    if (prev) props.prefetchSession(prev, priority)
  }

  const hoverPrefetch = {
    current: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const cancelHoverPrefetch = () => {
    if (hoverPrefetch.current === undefined) return
    clearTimeout(hoverPrefetch.current)
    hoverPrefetch.current = undefined
  }
  const scheduleHoverPrefetch = () => {
    warm("high")
    if (hoverPrefetch.current !== undefined) return
    hoverPrefetch.current = setTimeout(() => {
      hoverPrefetch.current = undefined
      warm("low")
    }, 80)
  }

  onCleanup(() => {
    cancelHoverPrefetch()
    if (copiedTimer) clearTimeout(copiedTimer)
  })
  const item = (
    <SessionRow
      session={props.session}
      mobile={props.mobile}
      dense={props.dense}
      active={isSelected()}
      tint={tint}
      isWorking={isWorking}
      hasPermissions={hasPermissions}
      hasError={hasError}
      unseenCount={unseenCount}
      sidebarOpened={layout.sidebar.opened}
      select={() => props.selectSession(props.session)}
      warmHover={() => undefined}
      warmPress={() => warm("high")}
      warmFocus={() => warm("high")}
      cancelHoverPrefetch={cancelHoverPrefetch}
      detail={detail}
      reduced={props.reduced}
      shimmer={titleShimmer}
      editingTitle={editingTitle}
      InlineEditor={props.InlineEditor}
      renameSession={renameSession}
    />
  )

  return (
    <ContextMenu modal>
      <ContextMenu.Trigger
        as="div"
        data-session-id={props.session.id}
        data-component="sidebar-session"
        data-active={isSelected() ? "true" : "false"}
        classList={{
          "group/session relative flex items-center w-full min-w-0 rounded-[22px] cursor-default pl-4 pr-3 border border-transparent":
            true,
          "transition-[background-color,border-color,box-shadow]": !props.reduced,
        }}
      >
      <div class="min-w-0 grow">
        <Show
          when={!tooltip()}
          fallback={
            <Tooltip
              placement={props.mobile ? "bottom" : "right"}
              value={stripScheduledSessionTitle(props.session.title)}
              gutter={10}
            >
              {item}
            </Tooltip>
          }
        >
          {item}
        </Show>
      </div>

      <div class="shrink-0 flex items-center gap-1">
        <div
          class="relative overflow-hidden flex items-center gap-1"
          classList={{
            "transition-[width,opacity]": !props.reduced,
            "w-[84px] opacity-100 pointer-events-auto":
              !!props.mobile || (!props.mobile && !props.reduced && !!jumpKeybind()),
            "w-0 opacity-0 pointer-events-none": (!props.mobile && !jumpKeybind()) || !!props.reduced,
            "group-hover/session:w-[84px] group-hover/session:opacity-100 group-hover/session:pointer-events-auto":
              !props.reduced,
            "group-focus-within/session:w-[84px] group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto":
              !props.reduced,
          }}
        >
          <Show when={!props.mobile && !props.reduced && jumpKeybind()}>
            {(keybind) => (
              <Keybind class="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 h-5 rounded-md border border-border-base/60 bg-surface-base/70 px-1.5 text-[11px] text-text-weak shadow-none transition-opacity duration-150 group-hover/session:opacity-0 group-focus-within/session:opacity-0">
                {keybind()}
              </Keybind>
            )}
          </Show>
          <Show
            when={!props.reduced}
            fallback={
              <>
                <IconButton
                  icon="refresh"
                  variant="ghost"
                  class="size-6 rounded-md shrink-0"
                  aria-label={language.t("session.generateTitle")}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    generateTitle()
                  }}
                />
                <IconButton
                  icon={menu.copied ? "check" : "copy"}
                  variant="ghost"
                  class="size-6 rounded-md shrink-0"
                  aria-label={language.t("session.copyInfo")}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    copy()
                  }}
                />
                <IconButton
                  icon="archive"
                  variant="ghost"
                  class="size-6 rounded-md shrink-0"
                  aria-label={language.t("common.archive")}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void props.archiveSession(props.session)
                  }}
                />
              </>
            }
          >
            <>
              <Tooltip value={language.t("session.generateTitle")} placement="top">
                <IconButton
                  icon="refresh"
                  variant="ghost"
                  class="size-6 rounded-md shrink-0 transition-opacity duration-150 group-hover/session:opacity-100 group-focus-within/session:opacity-100"
                  classList={{
                    "opacity-0 pointer-events-none group-hover/session:pointer-events-auto group-focus-within/session:pointer-events-auto":
                      !props.mobile && !!jumpKeybind(),
                  }}
                  aria-label={language.t("session.generateTitle")}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    generateTitle()
                  }}
                />
              </Tooltip>
              <Tooltip value={language.t("session.copyInfo")} placement="top">
                <IconButton
                  icon={menu.copied ? "check" : "copy"}
                  variant="ghost"
                  class="size-6 rounded-md shrink-0 transition-opacity duration-150 group-hover/session:opacity-100 group-focus-within/session:opacity-100"
                  classList={{
                    "opacity-0 pointer-events-none group-hover/session:pointer-events-auto group-focus-within/session:pointer-events-auto":
                      !props.mobile && !!jumpKeybind(),
                  }}
                  aria-label={language.t("session.copyInfo")}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    copy()
                  }}
                />
              </Tooltip>
              <Tooltip value={language.t("common.archive")} placement="top">
                <IconButton
                  icon="archive"
                  variant="ghost"
                  class="size-6 rounded-md shrink-0 transition-opacity duration-150 group-hover/session:opacity-100 group-focus-within/session:opacity-100"
                  classList={{
                    "opacity-0 pointer-events-none group-hover/session:pointer-events-auto group-focus-within/session:pointer-events-auto":
                      !props.mobile && !!jumpKeybind(),
                  }}
                  aria-label={language.t("common.archive")}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void props.archiveSession(props.session)
                  }}
                />
              </Tooltip>
            </>
          </Show>
        </div>
        <Show when={detail()}>
          <div class="shrink-0 size-6 flex items-center justify-center">
            <Icon name="branch" size="normal" class="text-icon-success-base" />
          </div>
        </Show>
      </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          onCloseAutoFocus={(event) => {
            if (!menu.pendingRename) return
            event.preventDefault()
            setMenu("pendingRename", false)
            props.openEditor(`session:${props.session.id}`, stripScheduledSessionTitle(props.session.title))
          }}
        >
          <ContextMenu.Item
            data-action="session-copy-info"
            data-session={base64Encode(props.session.id)}
            onSelect={copy}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name={menu.copied ? "check" : "copy"} size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{language.t("session.copyInfo")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="session-generate-title"
            data-session={base64Encode(props.session.id)}
            onSelect={generateTitle}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name="refresh" size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{language.t("session.generateTitle")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="session-rename"
            data-session={base64Encode(props.session.id)}
            onSelect={() => setMenu("pendingRename", true)}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name="edit" size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            data-action="session-archive"
            data-session={base64Encode(props.session.id)}
            onSelect={() => {
              void props.archiveSession(props.session)
            }}
          >
            <ContextMenu.Icon>
              <span class="flex shrink-0 text-icon-base">
                <Icon name="archive" size="small" />
              </span>
            </ContextMenu.Icon>
            <ContextMenu.ItemLabel>{language.t("common.archive")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

export const NewSessionItem = (props: {
  slug: string
  mobile?: boolean
  dense?: boolean
  reduced?: boolean
  sidebarExpanded: Accessor<boolean>
}): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      class={`flex items-center gap-1 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        layout.sidebar.close()
      }}
    >
      <div class="flex items-center gap-1 w-full">
        <div class="shrink-0 size-6 flex items-center justify-center">
          <Icon
            name="plus"
            size="small"
            classList={{ "text-icon-weak": true, "group-hover/session:text-icon-base": !props.reduced }}
          />
        </div>
        <span
          classList={{
            "text-14-regular text-text-weak grow-1 min-w-0 overflow-hidden text-ellipsis truncate": true,
            "group-hover/session:text-text-strong transition-colors": !props.reduced,
          }}
        >
          {label}
        </span>
      </div>
    </A>
  )

  return (
    <div
      classList={{
        "group/session relative w-full min-w-0 rounded-lg cursor-default pl-2 pr-3": true,
        "transition-colors hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover":
          !props.reduced,
      }}
    >
      <Show
        when={!tooltip()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10} class="min-w-0 w-full">
            {item}
          </Tooltip>
        }
      >
        {item}
      </Show>
    </div>
  )
}


export const SessionGroupHeader = (props: { label: string }): JSX.Element => (
  <div class="px-4 pt-3 pb-1 first:pt-1 flex justify-end">
    <span class="text-[11px] font-medium uppercase tracking-wider text-text-weak opacity-60">{props.label}</span>
  </div>
)

export const SessionSearchBar = (props: {
  value: Accessor<string>
  onInput: (value: string) => void
  placeholder: string
  reduced?: boolean
}): JSX.Element => (
  <div class="px-3 py-2">
    <div
      classList={{
        "flex items-center gap-2 px-2.5 h-8 rounded-lg border border-transparent": true,
        "transition-colors focus-within:bg-surface-base focus-within:border-border-weak-base": !props.reduced,
      }}
    >
      <Icon name="magnifying-glass" size="small" class="text-icon-weak shrink-0" />
      <input
        type="text"
        value={props.value()}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        placeholder={props.placeholder}
        class="flex-1 bg-transparent outline-none text-text-base placeholder:text-text-weak"
        style={{ "font-size": "13px" }}
      />
      <Show when={props.value()}>
        <IconButton icon="close-small" variant="ghost" class="size-5 rounded" onClick={() => props.onInput("")} />
      </Show>
    </div>
  </div>
)
