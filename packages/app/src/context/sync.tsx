import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/core/util/binary"
import { createSimpleContext } from "@opencode-ai/ui/context"
import {
  clearSessionPrefetch,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  markSessionHot,
} from "./global-sync/session-prefetch"
import { markSessionProfile } from "@/utils/session-profile"
import { useGlobalSync } from "./global-sync"
import { useSDK } from "./sdk"
import type { Message, Part, Session, UserMessageIndexItem } from "@opencode-ai/sdk/v2/client"
import type { SessionHistoryMeta } from "./global-sync/types"
import { SESSION_CACHE_LIMIT, dropSessionCaches, pickSessionCacheEvictions } from "./global-sync/session-cache"

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

export function shown(input: { cached: number; show?: number; page: number }) {
  if (input.cached <= 0) return 0
  const value = input.show === undefined ? Math.min(input.cached, input.page) : input.show
  return Math.max(0, Math.min(input.cached, value))
}

export function reveal(input: { cached: number; show?: number; step: number; page: number }) {
  return Math.min(input.cached, shown(input) + input.step)
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
    const maxDirs = 30
    const seen = new Map<string, Set<string>>()
    const [meta, setMeta] = createStore({
      show: {} as Record<string, number | undefined>,
      cursor: {} as Record<string, string | undefined>,
      complete: {} as Record<string, boolean>,
    })
    const [userMessageIndex, setUserMessageIndex] = createStore({
      items: {} as Record<string, UserMessageIndexItem[] | undefined>,
      loading: {} as Record<string, boolean>,
      failed: {} as Record<string, boolean>,
    })
    let syncVersion = globalSync.version
    createEffect(() => {
      const next = globalSync.version
      if (next === syncVersion) return
      syncVersion = next
      inflight.clear()
      seen.clear()
      setMeta({ show: {}, cursor: {}, complete: {} })
      setUserMessageIndex({ items: {}, loading: {}, failed: {} })
    })
    const unsubscribeMessageRemoved = sdk.event.on("message.removed", (event) => {
      const props = event.properties
      const key = keyFor(sdk.directory, props.sessionID)
      if (!userMessageIndex.items[key]) return
      setUserMessageIndex("items", key, (items) => items?.filter((item) => item.id !== props.messageID))
      console.debug(
        `[sync] user-message-index remove directory=${sdk.directory} sid=${props.sessionID} message=${props.messageID}`,
      )
    })
    onCleanup(unsubscribeMessageRemoved)

    const getSession = (sessionID: string) => {
      return globalSync.session.info.get(sdk.directory, sessionID)
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
        if (!globalSync.loaded(first)) {
          clearMeta(first, stale)
          continue
        }
        const [, setStore] = globalSync.child(first, { bootstrap: false })
        evict(first, setStore, stale)
      }
      return created
    }

    const clearMeta = (directory: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      setMeta(
        produce((draft) => {
          for (const sessionID of sessionIDs) {
            const key = keyFor(directory, sessionID)
            delete draft.show[key]
            delete draft.cursor[key]
            delete draft.complete[key]
          }
        }),
      )
      setUserMessageIndex(
        produce((draft) => {
          for (const sessionID of sessionIDs) {
            const key = keyFor(directory, sessionID)
            delete draft.items[key]
            delete draft.loading[key]
            delete draft.failed[key]
          }
        }),
      )
    }

    const evict = (directory: string, setStore: Setter, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      clearSessionPrefetch(directory, sessionIDs)
      globalSync.session.clear(directory, sessionIDs)
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

    const count = (directory: string, sessionID: string) => {
      return globalSync.session.messages.get(directory, sessionID)?.length ?? 0
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
      sessionID: string
      limit: number
      before?: string
      mode?: "replace" | "prepend"
    }) => {
      const key = keyFor(input.directory, input.sessionID)
      console.debug(
        `[sync] messages load-start directory=${input.directory} sid=${input.sessionID} mode=${input.mode ?? "replace"} limit=${String(input.limit)} before=${input.before ?? "none"} cached=${String(count(input.directory, input.sessionID))}`,
      )
      const result = await globalSync.session.messages.load(input)
      if (!result.committed) return false
      const previousShow = meta.show[key]
      const nextShow = previousShow !== undefined && previousShow > result.count ? result.count : previousShow
      batch(() => {
        if (nextShow !== previousShow) setMeta("show", key, nextShow)
        setMeta("cursor", key, result.cursor)
        setMeta("complete", key, result.complete)
      })
      globalSync.session.messages.setShow(input.directory, input.sessionID, nextShow)
      markSessionProfile(input.sessionID, "store-commit", `count=${String(result.count)}`)
      console.debug(
        `[sync] messages load-end directory=${input.directory} sid=${input.sessionID} mode=${input.mode ?? "replace"} count=${String(result.count)} show=${String(meta.show[key] ?? "none")}`,
      )
      return true
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
        status: {
          get(sessionID: string) {
            return globalSync.session.status.get(sdk.directory, sessionID)
          },
          all() {
            return globalSync.session.status.all(sdk.directory)
          },
        },
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
          })
        },
        optimistic: {
          add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
            const directory = input.directory ?? sdk.directory
            globalSync.session.messages.optimistic.add(directory, input)
          },
          complete(input: { directory?: string; sessionID: string; messageID: string }) {
            const directory = input.directory ?? sdk.directory
            globalSync.session.messages.optimistic.complete(directory, input)
          },
          remove(input: { directory?: string; sessionID: string; messageID: string }) {
            const directory = input.directory ?? sdk.directory
            globalSync.session.messages.optimistic.remove(directory, input)
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
          globalSync.session.messages.optimistic.add(sdk.directory, {
            sessionID: input.sessionID,
            message,
            parts: input.parts,
          })
        },
        async sync(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          markSessionHot(directory, sessionID)
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
            })
          } else if (seeded && store.message[sessionID] !== undefined && meta.complete[key] === undefined) {
            batch(() => {
              setMeta("cursor", key, seeded.cursor)
              setMeta("complete", key, seeded.complete)
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
                : opts?.force
                  ? globalSync.session.info.refresh(directory, sessionID)
                  : globalSync.session.info.ensure(directory, sessionID)

            const messagesReq =
              cached && !opts?.force
                ? Promise.resolve()
                : loadMessages({
                    directory,
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
          const [, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          return opts?.force
            ? globalSync.session.diff.refresh(directory, sessionID)
            : globalSync.session.diff.ensure(directory, sessionID)
        },
        async todo(sessionID: string, opts?: { force?: boolean }) {
          const directory = sdk.directory
          const [, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          return opts?.force
            ? globalSync.session.todo.refresh(directory, sessionID)
            : globalSync.session.todo.ensure(directory, sessionID)
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
            return globalSync.session.messages.loading(sdk.directory, sessionID)
          },
          async loadMore(sessionID: string, count?: number) {
            const directory = sdk.directory
            const [, setStore] = globalSync.child(directory)
            touch(directory, setStore, sessionID)
            const key = keyFor(directory, sessionID)
            const step = count ?? historyMessagePageSize
            const complete = meta.complete[key] ?? false
            const cursor = meta.cursor[key]
            if (globalSync.session.messages.loading(directory, sessionID)) {
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
              globalSync.session.messages.setShow(directory, sessionID, nextShow)
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
              sessionID,
              limit: step,
              before: cursor,
              mode: "prepend",
            })
            if (!committed) {
              console.debug(
                `[sync] history page-discarded directory=${directory} sid=${sessionID} reason=stale-generation`,
              )
              return
            }
            const nextShow = reveal({
              cached: current()[0].message[sessionID]?.length ?? 0,
              show,
              step,
              page: initialMessagePageSize,
            })
            setMeta("show", key, nextShow)
            globalSync.session.messages.setShow(directory, sessionID, nextShow)
            console.debug(
              `[sync] history load-end directory=${directory} sid=${sessionID} cached=${String(current()[0].message[sessionID]?.length ?? 0)} show=${String(view(directory, sessionID))} complete=${String(meta.complete[key] ?? false)} cursor=${String(!!meta.cursor[key])}`,
            )
          },
        },
        userMessageIndex: {
          get(sessionID: string) {
            return userMessageIndex.items[keyFor(sdk.directory, sessionID)]
          },
          loading(sessionID: string) {
            return userMessageIndex.loading[keyFor(sdk.directory, sessionID)] ?? false
          },
          failed(sessionID: string) {
            return userMessageIndex.failed[keyFor(sdk.directory, sessionID)] ?? false
          },
          async ensure(sessionID: string, opts?: { force?: boolean }) {
            const directory = sdk.directory
            const key = keyFor(directory, sessionID)
            if (!opts?.force && userMessageIndex.items[key] !== undefined) return
            return runInflight(inflight, `user-message-index\n${key}`, async () => {
              setUserMessageIndex("loading", key, true)
              setUserMessageIndex("failed", key, false)
              console.debug(
                `[sync] user-message-index load-start directory=${directory} sid=${sessionID} force=${String(!!opts?.force)}`,
              )
              try {
                const response = await sdk.client.session.userMessageIndex({ sessionID, directory })
                if (sdk.directory !== directory) return
                const items = response.data ?? []
                setUserMessageIndex("items", key, items)
                console.debug(
                  `[sync] user-message-index load-end directory=${directory} sid=${sessionID} count=${String(items.length)}`,
                )
              } catch (error) {
                setUserMessageIndex("failed", key, true)
                console.debug(
                  `[sync] user-message-index load-error directory=${directory} sid=${sessionID} error=${error instanceof Error ? error.message : String(error)}`,
                )
                throw error
              } finally {
                setUserMessageIndex("loading", key, false)
              }
            })
          },
        },
        evict(sessionID: string, directory = sdk.directory) {
          const [, setStore] = globalSync.child(directory)
          seenFor(directory).delete(sessionID)
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
          const [store, setStore] = globalSync.child(directory)
          const info = store.session.find((session) => session.id === sessionID)
          await client.session.update({ sessionID, time: { archived: Date.now() } })
          seenFor(directory).delete(sessionID)
          evict(directory, setStore, [sessionID])
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (!match.found) return
              draft.session.splice(match.index, 1)
              if (!info?.parentID) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
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
