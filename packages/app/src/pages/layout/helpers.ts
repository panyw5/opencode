import { getFilename } from "@opencode-ai/core/util/path"
import { type Message, type PermissionRequest, type Session, type SessionStatus } from "@opencode-ai/sdk/v2/client"
import { working } from "../session/session-working"

type SessionStore = {
  session?: Session[]
  sessions?: "idle" | "loading" | "ready"
  path: { directory: string }
}

export function permissionAlertUsesToast(input: {
  sessionID: string
  sessions: Array<{ id: string; parentID?: string }>
  openSessionIDs: string[]
  currentSessionID?: string
}) {
  const covered = new Set(input.openSessionIDs)
  if (input.currentSessionID) covered.add(input.currentSessionID)
  const parentByID = new Map<string, string>()
  for (const session of input.sessions) {
    if (session.parentID) parentByID.set(session.id, session.parentID)
  }
  const seen = new Set<string>()
  let sessionID: string | undefined = input.sessionID
  while (sessionID && !seen.has(sessionID)) {
    if (covered.has(sessionID)) return false
    seen.add(sessionID)
    sessionID = parentByID.get(sessionID)
  }
  return true
}

export type ProjectOwnerInput = {
  worktree: string
  sandboxes?: string[]
}

export type ProjectOwner<T extends ProjectOwnerInput> = {
  project: T
  root: string
  directory: string
  sandbox: boolean
}

export const workspaceKey = (directory: string) => {
  const value = directory.replaceAll("\\", "/")
  const drive = value.match(/^([A-Za-z]:)\/+$/)
  if (drive) return `${drive[1]}/`
  if (/^\/+$/i.test(value)) return "/"
  return value.replace(/\/+$/, "")
}

/** macOS often exposes the same folder as both /tmp and /private/tmp (and /var). */
export function workspacePathAliases(directory: string): string[] {
  const key = workspaceKey(directory)
  if (!key) return []
  const aliases = new Set<string>([directory, key])
  const add = (value: string) => {
    const next = workspaceKey(value)
    if (next) aliases.add(next)
  }
  if (key === "/tmp" || key.startsWith("/tmp/")) add(key.replace(/^\/tmp/, "/private/tmp"))
  if (key === "/private/tmp" || key.startsWith("/private/tmp/")) add(key.replace(/^\/private\/tmp/, "/tmp"))
  if (key === "/var" || key.startsWith("/var/")) add(key.replace(/^\/var/, "/private/var"))
  if (key === "/private/var" || key.startsWith("/private/var/")) add(key.replace(/^\/private\/var/, "/var"))
  return [...aliases]
}

export function sameWorkspacePath(a: string, b: string) {
  if (!a || !b) return false
  const left = workspaceKey(a)
  const right = workspaceKey(b)
  if (left === right) return true
  const aliases = new Set(workspacePathAliases(a).map(workspaceKey))
  return aliases.has(right)
}

export const canonicalWorkspaceDir = (route: string, canonical?: string) => {
  if (!canonical) return route
  if (workspaceKey(route) !== workspaceKey(canonical)) return route
  return canonical
}

export function projectOwner<T extends ProjectOwnerInput>(directory: string | undefined, projects: T[]) {
  if (!directory) return
  const key = workspaceKey(directory)
  if (!key) return

  const exact = projects.find((item) => workspaceKey(item.worktree) === key)
  if (exact) {
    const stale = projects.find(
      (item) =>
        workspaceKey(item.worktree) !== key && item.sandboxes?.some((sandbox) => workspaceKey(sandbox) === key),
    )
    if (stale) {
      console.debug("[layout] project owner ignored sandbox because worktree matched first", {
        directory,
        worktree: exact.worktree,
        sandboxOf: stale.worktree,
      })
    }
    return {
      project: exact,
      root: exact.worktree,
      directory: exact.worktree,
      sandbox: false,
    } satisfies ProjectOwner<T>
  }

  for (const item of projects) {
    const sandbox = item.sandboxes?.find((entry) => workspaceKey(entry) === key)
    if (!sandbox) continue
    return {
      project: item,
      root: item.worktree,
      directory: sandbox,
      sandbox: true,
    } satisfies ProjectOwner<T>
  }
}

export async function waitForMatch<T>(
  read: () => T,
  match: (value: T) => boolean,
  opts?: { tries?: number; delay?: number },
) {
  const tries = opts?.tries ?? 20
  const delay = opts?.delay ?? 10
  for (let count = 0; count < tries; count += 1) {
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (match(read())) return true
  }
  return false
}

function sortSessions(_now: number) {
  return (a: Session, b: Session) => {
    const aUpdated = a.time.updated ?? a.time.created
    const bUpdated = b.time.updated ?? b.time.created
    if (aUpdated !== bUpdated) return bUpdated - aUpdated
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
}

const isRootVisibleSession = (session: Session, directory: string) =>
  workspaceKey(session.directory) === workspaceKey(directory) && !session.parentID && !session.time?.archived

const roots = (store: SessionStore) =>
  (store.session ?? []).filter((session) => isRootVisibleSession(session, store.path.directory))

export const hasVisibleRootSessions = (store: SessionStore) => roots(store).length > 0

export const isInitialSessionLoad = (stores: SessionStore[]) =>
  stores.some((store) => store.sessions === "loading") && !stores.some(hasVisibleRootSessions)

export const sortedRootSessions = (store: SessionStore, now: number) => roots(store).sort(sortSessions(now))

export const sortedProjectSessions = (stores: SessionStore[], now: number) => stores.flatMap(roots).sort(sortSessions(now))

/** Filter sessions belonging to an IM channel (`title` prefix `[im:{name}]`). */
export function filterImChannelSessions(list: Session[], channel: string | undefined | null): Session[] {
  if (!channel) return list
  const prefix = `[im:${channel}]`
  return list.filter((session) => session.title?.startsWith(prefix))
}

/** Display title without the internal `[im:name]` marker. */
export function stripImChannelTitle(title: string | undefined, channel: string): string {
  if (!title) return ""
  const prefix = `[im:${channel}]`
  if (!title.startsWith(prefix)) return title
  const rest = title.slice(prefix.length).trimStart()
  return rest || title
}

/** Sessions written by scheduled tasks use this title prefix (server-owned). */
export const SCHEDULED_SESSION_TITLE_PREFIX = "[scheduled]"

export function isScheduledSessionTitle(title: string | undefined | null): boolean {
  return !!title?.startsWith(SCHEDULED_SESSION_TITLE_PREFIX)
}

/** Display title without the internal `[scheduled]` marker. */
export function stripScheduledSessionTitle(title: string | undefined | null): string {
  if (!title) return ""
  if (!isScheduledSessionTitle(title)) return title
  const rest = title.slice(SCHEDULED_SESSION_TITLE_PREFIX.length).trimStart()
  return rest || title
}

/** Sanitize channel name for default work-folder segment (mirrors server). */
export function sanitizeChannelName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || "channel"
}

/**
 * Expand `~` against home. Frontend-safe (no Node path module).
 * Absolute paths returned as-is.
 */
export function expandHomePath(input: string, home: string): string {
  const raw = input.trim()
  if (!raw) return raw
  if (raw === "~") return home
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    const rest = raw.slice(2).replace(/\\/g, "/")
    const base = home.replace(/[\\/]+$/, "")
    return `${base}/${rest}`
  }
  return raw
}

/**
 * Default IM work folder: `{configDir}/channels/{channelName}`
 * (same family as quick-assistant under path.config).
 * Must stay in sync with `packages/opencode/src/channel/directory.ts`.
 */
export function defaultChannelDirectory(channelName: string, configDir: string): string {
  if (/^[A-Za-z]:[\\/]/.test(configDir)) {
    const base = configDir.replace(/[\\/]+$/, "").replace(/\//g, "\\")
    return `${base}\\channels\\${sanitizeChannelName(channelName)}`
  }
  const base = configDir.replace(/[\\/]+$/, "")
  return `${base}/channels/${sanitizeChannelName(channelName)}`
}

/**
 * Resolve a channel's work directory from config.
 * Prefer explicit `directory`; otherwise `{configDir}/channels/{name}`.
 */
export function resolveChannelDirectory(
  channelName: string,
  directory: string | undefined | null,
  configDir: string,
  home: string,
): string {
  const explicit = directory?.trim()
  if (explicit) {
    const resolved = expandHomePath(explicit, home)
    // The server resolves Windows paths with node:path before storing a
    // session. Keep the browser request byte-for-byte compatible with it.
    return /^[A-Za-z]:[\\/]/.test(resolved) ? resolved.replace(/\//g, "\\") : resolved
  }
  return defaultChannelDirectory(channelName, configDir)
}

export type ImChannelConfigEntry = {
  type: string
  directory?: string
  enabled?: boolean
}

export type ImChannelMatch = {
  name: string
  type: string
  directory: string
}

/**
 * Map a route/work directory back to an IM channel config entry.
 * Used so channel session lists are first-class domains (like extra agents),
 * not filters nested under OpenCode project lists.
 */
export function findImChannelByDirectory(
  directory: string | undefined,
  channels: Record<string, ImChannelConfigEntry | undefined> | undefined | null,
  configDir: string,
  home: string,
): ImChannelMatch | undefined {
  if (!directory || !channels) return undefined
  const key = workspaceKey(directory)
  if (!key) return undefined
  for (const [name, entry] of Object.entries(channels)) {
    if (!entry || entry.enabled === false) continue
    const dir = resolveChannelDirectory(name, entry.directory, configDir, home)
    if (workspaceKey(dir) === key) {
      return { name, type: entry.type, directory: dir }
    }
  }
  return undefined
}

/**
 * Virtual LocalProject for an IM channel work directory.
 * Mirrors extraAgentProject so resolveProject / sidebar treat the channel as
 * its own session list domain.
 */
export function imChannelProject(name: string, directory: string): {
  id: string
  worktree: string
  name: string
  expanded: true
  vcs: undefined
  sandboxes: []
} {
  return {
    id: `im:${name}`,
    worktree: directory,
    name,
    expanded: true,
    vcs: undefined,
    sandboxes: [],
  }
}

export const latestRootSession = (stores: SessionStore[], now: number) =>
  sortedProjectSessions(stores, now)[0]

export const latestWorkspaceSession = (store: SessionStore, now: number) => latestRootSession([store], now)

export const latestProjectSession = (
  input: {
    root: string
    dirs: string[]
    recent?: { directory: string; id: string; at: number }
    stores: SessionStore[]
  },
  now: number,
) => {
  const key = workspaceKey(input.root)
  const dirs = input.dirs.filter((dir) => workspaceKey(dir) !== key)
  const all = [input.root, ...dirs]
  const allowed = new Set(all.map(workspaceKey))
  const stores = input.stores.filter((store) => allowed.has(workspaceKey(store.path.directory)))
  const recent =
    input.recent &&
    all.some((dir) => workspaceKey(dir) === workspaceKey(input.recent!.directory)) &&
    stores
      .flatMap(roots)
      .find(
        (session) =>
          workspaceKey(session.directory) === workspaceKey(input.recent!.directory) && session.id === input.recent!.id,
      )
  if (recent) return recent
  return latestRootSession(stores, now)
}

export function sessionByOneBasedIndex(sessions: readonly Session[], index: number) {
  if (!Number.isInteger(index) || index < 1) return
  return sessions[index - 1]
}

export function hasProjectPermissions(
  session: Session[],
  request: Record<string, PermissionRequest[] | undefined>,
  directory: string,
  include: (item: PermissionRequest) => boolean = () => true,
) {
  const children = childMapByParent(session)
  return session
    .filter((item) => isRootVisibleSession(item, directory))
    .some((root) => {
      const seen = new Set([root.id])
      const ids = [root.id]
      for (const id of ids) {
        const list = children.get(id)
        if (!list) continue
        for (const child of list) {
          if (seen.has(child)) continue
          seen.add(child)
          ids.push(child)
        }
      }
      return ids.some((id) => request[id]?.some(include))
    })
}

export const childMapByParent = (sessions: readonly Session[] | undefined) => {
  const map = new Map<string, string[]>()
  for (const session of sessions ?? []) {
    if (!session.parentID) continue
    const existing = map.get(session.parentID)
    if (existing) {
      existing.push(session.id)
      continue
    }
    map.set(session.parentID, [session.id])
  }
  return map
}

/** Return active sessions in a root's complete child-agent tree, parent first. */
export function workingSessionTreeIDs(input: {
  sessionID: string
  sessions: readonly Session[] | undefined
  statuses: Record<string, SessionStatus | undefined>
  messages: Record<string, readonly Message[] | undefined>
}) {
  const children = childMapByParent(input.sessions)
  const seen = new Set<string>()
  const pending = [input.sessionID]
  const active: string[] = []

  for (const id of pending) {
    if (seen.has(id)) continue
    seen.add(id)
    if (working(input.statuses[id], input.messages[id])) active.push(id)
    for (const child of children.get(id) ?? []) pending.push(child)
  }

  return active
}

export const displayName = (project: { name?: string; worktree: string }) =>
  project.name || getFilename(project.worktree)

export type I18nTemplatePart = { type: "text"; value: string } | { type: "token" }

/** Split `Hello {{project}}` into text/token parts so the token can be styled. */
export function splitI18nTemplate(template: string, token: string): I18nTemplatePart[] {
  if (!template) return []
  const needle = `{{${token}}}`
  const chunks = template.split(needle)
  const parts: I18nTemplatePart[] = []
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i]) parts.push({ type: "text", value: chunks[i] })
    if (i < chunks.length - 1) parts.push({ type: "token" })
  }
  return parts
}

export function newSessionProjectLabel(
  directory: string | undefined,
  projects: Array<{ name?: string; worktree: string; sandboxes?: string[] }>,
  options?: { extraName?: string; sidebarRoot?: string },
) {
  if (!directory) return ""
  if (options?.extraName) return options.extraName
  const owner = projectOwner(directory, projects)
  if (owner) return displayName(owner.project)
  const sidebarRoot = options?.sidebarRoot
  if (sidebarRoot) {
    const sidebar = projects.find((item) => workspaceKey(item.worktree) === workspaceKey(sidebarRoot))
    if (sidebar) return displayName(sidebar)
  }
  return getFilename(directory) || directory
}

export type SessionGroupKey = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older"

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function sessionGroupKey(session: Session, now: number): SessionGroupKey {
  const today = startOfDay(now)
  const t = session.time.updated ?? session.time.created
  if (t >= today) return "today"
  if (t >= today - 86_400_000) return "yesterday"
  if (t >= today - 7 * 86_400_000) return "thisWeek"
  if (t >= today - 30 * 86_400_000) return "thisMonth"
  return "older"
}

/** Returns a Map from session ID to its group key, only for sessions that START a new group. */
export function sessionGroupBoundaries(sessions: Session[], now: number): Map<string, SessionGroupKey> {
  const headers = new Map<string, SessionGroupKey>()
  let lastKey: SessionGroupKey | undefined
  for (const session of sessions) {
    const key = sessionGroupKey(session, now)
    if (key !== lastKey) {
      headers.set(session.id, key)
      lastKey = key
    }
  }
  return headers
}

export const errorMessage = (err: unknown, fallback: string) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}

export const effectiveWorkspaceOrder = (local: string, dirs: string[], persisted?: string[]) => {
  const root = workspaceKey(local)
  const live = new Map<string, string>()

  for (const dir of dirs) {
    const key = workspaceKey(dir)
    if (key === root) continue
    if (!live.has(key)) live.set(key, dir)
  }

  if (!persisted?.length) return [local, ...live.values()]

  const result = [local]
  for (const dir of persisted) {
    const key = workspaceKey(dir)
    if (key === root) continue
    const match = live.get(key)
    if (!match) continue
    result.push(match)
    live.delete(key)
  }

  return [...result, ...live.values()]
}
