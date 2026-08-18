import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/core/util/binary"
import { retry } from "@opencode-ai/core/util/retry"
import { createSimpleContext } from "@opencode-ai/ui/context"
import {
  clearSessionPrefetch,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  setSessionPrefetch,
} from "./global-sync/session-prefetch"
import { markSessionProfile } from "@/utils/session-profile"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import type { SessionHistoryMeta } from "./global-sync/types"
import { SESSION_CACHE_LIMIT, dropSessionCaches, pickSessionCacheEvictions } from "./global-sync/session-cache"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// SyncProvider is recreated when the route changes directory, but its requests
// still write into the shared GlobalSync child store. Reject an older provider's
// response once a newer request for the same directory/session has started.
const messageLoadGeneration = new Map<string, number>()

function merge<T extends { id: string }>(a: readonly T[], b: readonly T[]) {
  const map = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) map.set(item.id, item)
  return [...map.values()].sort((x, y) => cmp(x.id, y.id))
}

export function shown(input: { cached: number; show?: number; page: number }) {
  if (input.cached <= 0) return 0
  const value = input.show === undefined ? Math.min(input.cached, input.page) : input.show
  return Math.max(0, Math.min(input.cached, value))
}

export function reveal(input: { cached: number; show?: number; step: number; page: number }) {
  return Math.min(input.cached, shown(input) + input.step)
}

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => Binary.search(parts, part.id, (item) => item.id).found)
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = Binary.search(next, part.id, (item) => item.id)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeFetchedParts(fetched: Part[], cached: Part[] | undefined) {
  if (!cached?.length) return fetched
  const current = new Map(cached.map((part) => [part.id, part] as const))
  return fetched.map((part) => {
    const existing = current.get(part.id)
    if (existing?.type !== "text" || part.type !== "text") return part
    const cachedText = existing.text ?? ""
    const fetchedText = part.text ?? ""
    if (cachedText.length <= fetchedText.length || !cachedText.startsWith(fetchedText)) return part

    console.warn("[sync] kept streaming text over stale session snapshot", {
      msg: part.messageID,
      part: part.id,
      cached: cachedText.length,
      snapshot: fetchedText.length,
      cachedTail: cachedText.slice(-40),
      snapshotTail: fetchedText.slice(-40),
    })
    return existing
  })
}

export function reconcileFetchedParts(parts: Part[]) {
  return reconcile(parts, { key: "id", merge: true })
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    const result = Binary.search(session, item.message.id, (message) => message.id)
    const found = result.found
    if (!found) session.splice(result.index, 0, item.message)

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    messages.splice(result.index, 0, input.message)
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (result.found) messages.splice(result.index, 1)
  }
  delete draft.part[input.messageID]
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    const next = [...messages]
    next.splice(result.index, 0, input.message)
    return next
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (!result.found) return messages
    const next = [...messages]
    next.splice(result.index, 1)
    return next
  })
  setStore("part", (part: Record<string, Part[] | undefined>) => {
    if (!(input.messageID in part)) return part
    const next = { ...part }
    delete next[input.messageID]
    return next
  })
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const globalSync = useGlobalSync()
    const sdk = useSDK()

    type Child = ReturnType<(typeof globalSync)["child"]>
    type Setter = Child[1]

    const current = createMemo(() => {
      // Rebind the current directory store whenever GlobalSync hot-resets for a server switch.
      globalSync.version
      return globalSync.child(sdk.directory, { bootstrap: false })
    })
    const target = (directory?: string) => {
      if (!directory || directory === sdk.directory) return current()
      globalSync.version
      return globalSync.child(directory, { bootstrap: false })
    }
    globalSync.project.warm(sdk.directory)
    const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
const initialMessagePageSize = 80
    // Keep history pages modest: large steps + a failed top pin used to dump the whole session at once.
    const historyMessagePageSize = 40
    const inflight = new Map<string, Promise<void>>()
    const inflightDiff = new Map<string, Promise<void>>()
    const inflightTodo = new Map<string, Promise<void>>()
    const optimistic = new Map<string, Map<string, OptimisticItem>>()
    const maxDirs = 30
    const seen = new Map<string, Set<string>>()
    const [meta, setMeta] = createStore({
      show: {} as Record<string, number | undefined>,
      cursor: {} as Record<string, string | undefined>,
      complete: {} as Record<string, boolean>,
      loading: {} as Record<string, boolean>,
    })

    const getSession = (sessionID: string) => {
      const store = current()[0]
      const match = Binary.search(store.session, sessionID, (s) => s.id)
      if (match.found) return store.session[match.index]
      return undefined
    }

    const setSession = (setStore: Setter, info: Session) => {
      setStore(
        "session",
        produce((draft: Session[]) => {
          const match = Binary.search(draft, info.id, (s) => s.id)
          if (match.found) {
            draft[match.index] = info
            return
          }
          draft.splice(match.index, 0, info)
        }),
      )
    }

    const setOptimistic = (directory: string, sessionID: string, item: OptimisticItem) => {
      const key = keyFor(directory, sessionID)
      const list = optimistic.get(key)
      if (list) {
        list.set(item.message.id, { message: item.message, parts: sortParts(item.parts) })
        return
      }
      optimistic.set(key, new Map([[item.message.id, { message: item.message, parts: sortParts(item.parts) }]]))
    }

    const clearOptimistic = (directory: string, sessionID: string, messageID?: string) => {
      const key = keyFor(directory, sessionID)
      if (!messageID) {
        optimistic.delete(key)
        return
      }

      const list = optimistic.get(key)
      if (!list) return
      list.delete(messageID)
      if (list.size === 0) optimistic.delete(key)
    }

    const getOptimistic = (directory: string, sessionID: string) => [
      ...(optimistic.get(keyFor(directory, sessionID))?.values() ?? []),
    ]

    const seenFor = (directory: string) => {
      const existing = seen.get(directory)
      if (existing) {
        seen.delete(directory)
        seen.set(directory, existing)
        return existing
      }
      const created = new Set<string>()
      seen.set(directory, created)
      while (seen.size > maxDirs) {
        const first = seen.keys().next().value
        if (!first) break
        const stale = [...(seen.get(first) ?? [])]
        seen.delete(first)
        const [, setStore] = globalSync.child(first, { bootstrap: false })
        evict(first, setStore, stale)
      }
      return created
    }

    const clearMeta = (directory: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      for (const sessionID of sessionIDs) {
        clearOptimistic(directory, sessionID)
      }
      setMeta(
        produce((draft) => {
          for (const sessionID of sessionIDs) {
            const key = keyFor(directory, sessionID)
            delete draft.show[key]
            delete draft.cursor[key]
            delete draft.complete[key]
            delete draft.loading[key]
          }
        }),
      )
    }

    const evict = (directory: string, setStore: Setter, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      clearSessionPrefetch(directory, sessionIDs)
      for (const sessionID of sessionIDs) {
        globalSync.todo.set(sessionID, undefined)
      }
      setStore(
        produce((draft) => {
          dropSessionCaches(draft, sessionIDs)
        }),
      )
      clearMeta(directory, sessionIDs)
    }

    const touch = (directory: string, setStore: Setter, sessionID: string) => {
      const stale = pickSessionCacheEvictions({
        seen: seenFor(directory),
        keep: sessionID,
        limit: SESSION_CACHE_LIMIT,
      })
      evict(directory, setStore, stale)
    }

    const fetchMessages = async (input: {
      client: typeof sdk.client
      sessionID: string
      limit: number
      before?: string
    }) => {
      const directory = sdk.directory
      const started = performance.now()
      markSessionProfile(
        input.sessionID,
        "messages-request-start",
        `limit=${String(input.limit)} before=${input.before ?? "none"}`,
      )
      const messages = await retry(() =>
        input.client.session.messages({ sessionID: input.sessionID, limit: input.limit, before: input.before }),
      ).catch((error) => {
        markSessionProfile(
          input.sessionID,
          "messages-request-error",
          `error=${error instanceof Error ? error.name : "unknown"}`,
        )
        throw error
      })
      const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
      const session = items.map((x) => x.info).sort((a, b) => cmp(a.id, b.id))
      const part = items.map((message) => ({ id: message.info.id, part: sortParts(message.parts) }))
      const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
      const result = {
        session,
        part,
        cursor,
        complete: !cursor,
      }
      markSessionProfile(
        input.sessionID,
        "messages-request-end",
        `duration_ms=${String(Math.round((performance.now() - started) * 10) / 10)} count=${String(session.length)}`,
      )
      return result
    }

    const tracked = (directory: string, sessionID: string) => seen.get(directory)?.has(sessionID) ?? false

    const count = (directory: string, sessionID: string) => {
      const [store] = target(directory)
      return store.message[sessionID]?.length ?? 0
    }

    const view = (directory: string, sessionID: string) => {
      return shown({
        cached: count(directory, sessionID),
        show: meta.show[keyFor(directory, sessionID)],
        page: initialMessagePageSize,
      })
    }

    const loadMessages = async (input: {
      directory: string
      client: typeof sdk.client
      setStore: Setter
      sessionID: string
      limit: number
      before?: string
      mode?: "replace" | "prepend"
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      if (meta.loading[key]) {
        console.debug(
          `[sync] messages skip-loading directory=${input.directory} sid=${input.sessionID} mode=${input.mode ?? "replace"}`,
        )
        return
      }

      const generation = (messageLoadGeneration.get(key) ?? 0) + 1
      messageLoadGeneration.set(key, generation)
      let committed = false
      console.debug(
        `[sync] messages load-start directory=${input.directory} sid=${input.sessionID} mode=${input.mode ?? "replace"} limit=${String(input.limit)} before=${input.before ?? "none"} cached=${String(count(input.directory, input.sessionID))}`,
      )
      setMeta("loading", key, true)
      await fetchMessages(input)
        .then((page) => {
          if (!tracked(input.directory, input.sessionID)) {
            console.debug(
              `[sync] messages page-discarded directory=${input.directory} sid=${input.sessionID} reason=untracked count=${String(page.session.length)}`,
            )
            return
          }
          if (messageLoadGeneration.get(key) !== generation) {
            console.debug(
              `[sync] messages page-discarded directory=${input.directory} sid=${input.sessionID} reason=stale-generation generation=${String(generation)} current=${String(messageLoadGeneration.get(key) ?? "none")}`,
            )
            return
          }
          const next = mergeOptimisticPage(page, getOptimistic(input.directory, input.sessionID))
          for (const messageID of next.confirmed) {
            clearOptimistic(input.directory, input.sessionID, messageID)
          }
          const [store] = globalSync.child(input.directory, { bootstrap: false })
          const cached = input.mode === "prepend" ? (store.message[input.sessionID] ?? []) : []
          const message = input.mode === "prepend" ? merge(cached, next.session) : next.session
          const previousShow = meta.show[key]
          const nextShow = previousShow !== undefined && previousShow > message.length ? message.length : previousShow
          console.debug(
            `[sync] messages page-ready directory=${input.directory} sid=${input.sessionID} mode=${input.mode ?? "replace"} fetched=${String(next.session.length)} cached=${String(cached.length)} merged=${String(message.length)} cursor=${String(!!next.cursor)} complete=${String(next.complete)}`,
          )
          markSessionProfile(input.sessionID, "store-commit", `count=${String(message.length)}`)
          batch(() => {
            input.setStore("message", input.sessionID, reconcile(message, { key: "id" }))
            for (const p of next.part) {
              const filtered = mergeFetchedParts(
                p.part.filter((x) => !SKIP_PARTS.has(x.type)),
                store.part[p.id],
              )
              if (filtered.length) input.setStore("part", p.id, reconcileFetchedParts(filtered))
            }
            if (nextShow !== previousShow) setMeta("show", key, nextShow)
            setMeta("cursor", key, next.cursor)
            setMeta("complete", key, next.complete)
            input.setStore("session_history", input.sessionID, {
              cursor: next.cursor,
              complete: next.complete,
              show: nextShow,
              at: Date.now(),
            } satisfies SessionHistoryMeta)
            setSessionPrefetch({
              directory: input.directory,
              sessionID: input.sessionID,
              count: message.length,
              cursor: next.cursor,
              complete: next.complete,
            })
          })
          committed = true
          console.debug(
            `[sync] messages store-committed directory=${input.directory} sid=${input.sessionID} count=${String(store.message[input.sessionID]?.length ?? 0)} show=${String(meta.show[key] ?? "none")} loading=${String(meta.loading[key] ?? false)}`,
          )
        })
        .catch((error) => {
          console.debug(
            `[sync] messages load-error directory=${input.directory} sid=${input.sessionID} mode=${input.mode ?? "replace"} error=${error instanceof Error ? error.message : String(error)}`,
          )
          throw error
        })
        .finally(() => {
          setMeta(
            produce((draft) => {
              if (!tracked(input.directory, input.sessionID)) {
                delete draft.loading[key]
                return
              }
              draft.loading[key] = false
            }),
          )
          console.debug(
            `[sync] messages load-end directory=${input.directory} sid=${input.sessionID} mode=${input.mode ?? "replace"} count=${String(count(input.directory, input.sessionID))} show=${String(meta.show[key] ?? "none")} loading=${String(meta.loading[key] ?? false)}`,
          )
        })
      return committed
    }

    return {
      get data() {
        return current()[0]
      },
      get set(): Setter {
        return current()[1]
      },
      get status() {
        return current()[0].status
      },
      get ready() {
        return current()[0].status !== "loading"
      },
      get project() {
        const store = current()[0]
        const id = store.project
        if (!id) return undefined
        const projects = globalSync.data.project
        const match = Binary.search(projects, id, (p) => p.id)
        if (match.found) return projects[match.index]
        for (const [, list] of Object.entries(globalSync.data.projectByDomain)) {
          if (!list || list === projects) continue
          const cross = Binary.search(list, id, (p) => p.id)
          if (cross.found) return list[cross.index]
        }
        return undefined
      },
      session: {
        get: getSession,
        created(input: { directory?: string; info: Session }) {
          const directory = input.directory ?? sdk.directory
          const [, setStore] = target(input.directory)
          const key = keyFor(directory, input.info.id)
          touch(directory, setStore, input.info.id)
          batch(() => {
            setSession(setStore, input.info)
            setStore("message", input.info.id, (messages: Message[] | undefined) => messages ?? [])
            setMeta("cursor", key, undefined)
            setMeta("complete", key, false)
            setMeta("loading", key, false)
          })
        },
        optimistic: {
          add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
            const directory = input.directory ?? sdk.directory
            const [, setStore] = target(input.directory)
            setOptimistic(directory, input.sessionID, { message: input.message, parts: input.parts })
            setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
          },
          complete(input: { directory?: string; sessionID: string; messageID: string }) {
            const directory = input.directory ?? sdk.directory
            const [, setStore] = target(input.directory)
            clearOptimistic(directory, input.sessionID, input.messageID)
            setStore("part", input.messageID, (parts: Part[]) =>
              parts.filter(
                (part) =>
                  !(
                    part.type === "text" &&
                    part.synthetic &&
                    part.metadata?.kind === "command-injection" &&
                    part.metadata.pending === true
                  ),
              ),
            )
          },
          remove(input: { directory?: string; sessionID: string; messageID: string }) {
            const directory = input.directory ?? sdk.directory
            const [, setStore] = target(input.directory)
            clearOptimistic(directory, input.sessionID, input.messageID)
            setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
          },
        },
        addOptimisticMessage(input: {
          sessionID: string
          messageID: string
          parts: Part[]
          agent: string
          model: { providerID: string; modelID: string }
          variant?: string
        }) {
          const message: Message = {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: { ...input.model, variant: input.variant },
          }
          const [, setStore] = target()
          setOptimistic(sdk.directory, input.sessionID, { message, parts: input.parts })
          setOptimisticAdd(setStore as (...args: unknown[]) => void, {
            sessionID: input.sessionID,
            message,
            parts: input.parts,
          })
        },
        async sync(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          const key = keyFor(directory, sessionID)
          markSessionProfile(sessionID, "sync-enter", `force=${String(!!opts?.force)}`)

          touch(directory, setStore, sessionID)

          const shared = store.session_history?.[sessionID]
          const seeded = getSessionPrefetch(directory, sessionID)
          console.debug(
            `[sync] sync-enter directory=${directory} sid=${sessionID} force=${String(!!opts?.force)} messages=${String(store.message[sessionID]?.length ?? 0)} metaComplete=${String(meta.complete[key] ?? "none")} metaShow=${String(meta.show[key] ?? "none")} shared=${shared ? `${String(shared.complete)}:${String(shared.show ?? "none")}` : "none"} prefetch=${seeded ? `${String(seeded.count)}:${String(seeded.complete)}:${String(seeded.at)}` : "none"}`,
          )
          if (shared && store.message[sessionID] !== undefined && meta.complete[key] === undefined) {
            batch(() => {
              setMeta("cursor", key, shared.cursor)
              setMeta("complete", key, shared.complete)
              setMeta("show", key, shared.show)
              setMeta("loading", key, false)
            })
          } else if (seeded && store.message[sessionID] !== undefined && meta.complete[key] === undefined) {
            batch(() => {
              setMeta("cursor", key, seeded.cursor)
              setMeta("complete", key, seeded.complete)
              setMeta("loading", key, false)
            })
            setStore("session_history", sessionID, {
              cursor: seeded.cursor,
              complete: seeded.complete,
              show: seeded.count,
              at: seeded.at,
            } satisfies SessionHistoryMeta)
          } else if (store.message[sessionID] !== undefined && meta.complete[key] === undefined) {
            // The directory provider can be recreated after prefetch metadata is
            // intentionally cleared. Keep the existing message cache visible while
            // the new provider rebuilds its cursor.
            setMeta("show", key, store.message[sessionID]?.length ?? 0)
            console.debug(
              `[sync] sync-cache-seed directory=${directory} sid=${sessionID} show=${String(store.message[sessionID]?.length ?? 0)} reason=message-cache-without-meta`,
            )
          }

          return runInflight(inflight, key, async () => {
            const pending = getSessionPrefetchPromise(directory, sessionID)
            if (pending) {
              markSessionProfile(sessionID, "prefetch-wait-start")
              // Prefetch is an optimization — if it fails or hangs, fall through
              // to a direct fetch instead of blocking the session view forever.
              await Promise.race([pending, new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
              markSessionProfile(sessionID, "prefetch-wait-end")
              const seeded = getSessionPrefetch(directory, sessionID)
              if (seeded && store.message[sessionID] !== undefined && meta.complete[key] === undefined) {
                batch(() => {
                  setMeta("cursor", key, seeded.cursor)
                  setMeta("complete", key, seeded.complete)
                  setMeta("loading", key, false)
                })
              }
            }

            const hasSession = Binary.search(store.session, sessionID, (s) => s.id).found
            const cached = store.message[sessionID] !== undefined && meta.complete[key] !== undefined
            const currentLength = store.message[sessionID]?.length ?? 0
            const currentShow = view(directory, sessionID)
            if (cached && hasSession && !opts?.force) {
              markSessionProfile(sessionID, "sync-cache-hit")
              return
            }

            const limit = Math.max(view(directory, sessionID), initialMessagePageSize)
            console.debug(
              `[sync] sync-fetch directory=${directory} sid=${sessionID} force=${String(!!opts?.force)} hasSession=${String(hasSession)} cached=${String(cached)} current=${String(currentLength)} view=${String(currentShow)} limit=${String(limit)}`,
            )
            const sessionReq =
              hasSession && !opts?.force
                ? Promise.resolve()
                : retry(() => client.session.get({ sessionID })).then((session) => {
                    if (!tracked(directory, sessionID)) return
                    const data = session.data
                    if (!data) return
                    setSession(setStore, data)
                  })

            const messagesReq =
              cached && !opts?.force
                ? Promise.resolve()
                : loadMessages({
                    directory,
                    client,
                    setStore,
                    sessionID,
                    limit,
                    mode: store.message[sessionID] !== undefined ? "prepend" : "replace",
                  })

            await Promise.all([sessionReq, messagesReq]).catch((error) => {
              markSessionProfile(
                sessionID,
                "sync-error",
                `force=${String(!!opts?.force)} error=${error instanceof Error ? error.name : "unknown"}`,
              )
              throw error
            })
            console.debug(
              `[sync] sync-end directory=${directory} sid=${sessionID} force=${String(!!opts?.force)} messages=${String(store.message[sessionID]?.length ?? 0)} complete=${String(meta.complete[key] ?? "none")} cursor=${String(!!meta.cursor[key])}`,
            )
            markSessionProfile(sessionID, "sync-end", `force=${String(!!opts?.force)}`)
          })
        },
        async diff(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          if (store.session_diff[sessionID] !== undefined && !opts?.force) return

          const key = keyFor(directory, sessionID)
          return runInflight(inflightDiff, key, () =>
            retry(() => client.session.diff({ sessionID })).then((diff) => {
              if (!tracked(directory, sessionID)) return
              setStore("session_diff", sessionID, reconcile(diff.data ?? [], { key: "file" }))
            }),
          )
        },
        async todo(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          const existing = store.todo[sessionID]
          const cached = globalSync.data.session_todo[sessionID]
          if (existing !== undefined) {
            if (cached === undefined) {
              globalSync.todo.set(sessionID, existing)
            }
            if (!opts?.force) return
          }

          if (cached !== undefined) {
            setStore("todo", sessionID, reconcile(cached, { key: "id" }))
          }

          const key = keyFor(directory, sessionID)
          return runInflight(inflightTodo, key, () =>
            retry(() => client.session.todo({ sessionID })).then((todo) => {
              if (!tracked(directory, sessionID)) return
              const list = todo.data ?? []
              setStore("todo", sessionID, reconcile(list, { key: "id" }))
              globalSync.todo.set(sessionID, list)
            }),
          )
        },
        history: {
          more(sessionID: string) {
            const store = current()[0]
            const key = keyFor(sdk.directory, sessionID)
            const cached = store.message[sessionID]?.length ?? 0
            if (cached === 0) return false
            if (view(sdk.directory, sessionID) < cached) return true
            if (meta.complete[key]) return false
            return !!meta.cursor[key]
          },
          limit(sessionID: string) {
            const cached = count(sdk.directory, sessionID)
            if (cached === 0) return undefined
            return view(sdk.directory, sessionID)
          },
          loading(sessionID: string) {
            const key = keyFor(sdk.directory, sessionID)
            return meta.loading[key] ?? false
          },
          async loadMore(sessionID: string, count?: number) {
            const directory = sdk.directory
            const client = sdk.client
            const [, setStore] = globalSync.child(directory)
            touch(directory, setStore, sessionID)
            const key = keyFor(directory, sessionID)
            const step = count ?? historyMessagePageSize
            const complete = meta.complete[key] ?? false
            const cursor = meta.cursor[key]
            if (meta.loading[key]) {
              console.debug(`[sync] history skip-loading directory=${directory} sid=${sessionID}`)
              return
            }
            const cached = current()[0].message[sessionID]?.length ?? 0
            const show = view(directory, sessionID)

            console.debug(
              `[sync] history load-start directory=${directory} sid=${sessionID} step=${String(step)} cached=${String(cached)} show=${String(show)} complete=${String(complete)} cursor=${String(!!cursor)}`,
            )

            if (show < cached) {
              const nextShow = reveal({ cached, show: meta.show[key], step, page: initialMessagePageSize })
              setMeta("show", key, nextShow)
              setStore("session_history", sessionID, {
                cursor: meta.cursor[key],
                complete: meta.complete[key] ?? false,
                show: nextShow,
                at: current()[0].session_history?.[sessionID]?.at ?? Date.now(),
              } satisfies SessionHistoryMeta)
              console.debug(
                `[sync] history reveal-only directory=${directory} sid=${sessionID} from=${String(show)} to=${String(nextShow)} cached=${String(cached)}`,
              )
              return
            }

            if (complete) {
              console.debug(`[sync] history skip-complete directory=${directory} sid=${sessionID}`)
              return
            }
            if (!cursor) {
              console.debug(`[sync] history skip-no-cursor directory=${directory} sid=${sessionID}`)
              return
            }

            const committed = await loadMessages({
              directory,
              client,
              setStore,
              sessionID,
              limit: step,
              before: cursor,
              mode: "prepend",
            })
            if (!committed) {
              console.debug(`[sync] history page-discarded directory=${directory} sid=${sessionID} reason=stale-generation`)
              return
            }
            const nextShow = reveal({
              cached: current()[0].message[sessionID]?.length ?? 0,
              show,
              step,
              page: initialMessagePageSize,
            })
            setMeta("show", key, nextShow)
            setStore("session_history", sessionID, {
              cursor: meta.cursor[key],
              complete: meta.complete[key] ?? false,
              show: nextShow,
              at: current()[0].session_history?.[sessionID]?.at ?? Date.now(),
            } satisfies SessionHistoryMeta)
            console.debug(
              `[sync] history load-end directory=${directory} sid=${sessionID} cached=${String(current()[0].message[sessionID]?.length ?? 0)} show=${String(view(directory, sessionID))} complete=${String(meta.complete[key] ?? false)} cursor=${String(!!meta.cursor[key])}`,
            )
          },
        },
        evict(sessionID: string, directory = sdk.directory) {
          const [, setStore] = globalSync.child(directory)
          seenFor(directory).delete(sessionID)
          const key = keyFor(directory, sessionID)
          messageLoadGeneration.set(key, (messageLoadGeneration.get(key) ?? 0) + 1)
          evict(directory, setStore, [sessionID])
        },
        fetch: async (count = 10) => {
          const directory = sdk.directory
          const client = sdk.client
          const [store, setStore] = globalSync.child(directory)
          setStore("limit", (x) => x + count)
          await client.session.list().then((x) => {
            const sessions = (x.data ?? [])
              .filter((s) => !!s?.id)
              .sort((a, b) => cmp(a.id, b.id))
              .slice(0, store.limit)
            setStore("session", reconcile(sessions, { key: "id" }))
          })
        },
        more: createMemo(() => current()[0].session.length >= current()[0].limit),
        archive: async (sessionID: string) => {
          const directory = sdk.directory
          const client = sdk.client
          const [, setStore] = globalSync.child(directory)
          await client.session.update({ sessionID, time: { archived: Date.now() } })
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session.splice(match.index, 1)
            }),
          )
        },
      },
      absolute,
      get directory() {
        return current()[0].path.directory
      },
    }
  },
})
