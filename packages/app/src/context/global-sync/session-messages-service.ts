import { Binary } from "@opencode-ai/core/util/binary"
import { retry } from "@opencode-ai/core/util/retry"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { batch } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { markSessionProfile } from "@/utils/session-profile"
import { setSessionPrefetch } from "./session-prefetch"
import {
  compareSessionItemID,
  mergeFetchedSessionParts,
  mergeOptimisticSessionPage,
  mergeSessionItems,
  reconcileFetchedSessionParts,
  SESSION_MESSAGE_SKIP_PARTS,
  sortSessionParts,
  type SessionMessagePage,
  type SessionOptimisticItem,
} from "./session-messages"
import type { SessionControllerDeps } from "./session-service-types"

type LoadResult = {
  committed: boolean
  count: number
  cursor?: string
  complete: boolean
}

export function createSessionMessagesService(deps: SessionControllerDeps) {
  const revision = new Map<string, number>()
  const discardRevision = new Map<string, number>()
  const generation = new Map<string, number>()
  const pageInflight = new Map<string, Promise<SessionMessagePage>>()
  const inflight = new Map<string, Promise<LoadResult>>()
  const optimistic = new Map<string, Map<string, SessionOptimisticItem>>()
  const [activity, setActivity] = createStore({ loading: {} as Record<string, number | undefined> })
  const keyFor = (directory: string, sessionID: string) => `${deps.canonical(directory)}\n${sessionID}`
  const rev = (directory: string, sessionID: string) => revision.get(keyFor(directory, sessionID)) ?? 0
  const bump = (directory: string, sessionID: string) => {
    const key = keyFor(directory, sessionID)
    revision.set(key, (revision.get(key) ?? 0) + 1)
  }

  const optimisticItems = (directory: string, sessionID: string) =>
    [...(optimistic.get(keyFor(directory, sessionID))?.values() ?? [])]

  const clearOptimistic = (directory: string, sessionID: string, messageID?: string) => {
    const key = keyFor(directory, sessionID)
    if (!messageID) {
      optimistic.delete(key)
      return
    }
    const items = optimistic.get(key)
    if (!items) return
    items.delete(messageID)
    if (items.size === 0) optimistic.delete(key)
  }

  const page = (input: { directory: string; sessionID: string; limit: number; before?: string }) => {
    const directory = deps.canonical(input.directory)
    const key = `${keyFor(directory, input.sessionID)}\n${String(input.limit)}\n${input.before ?? ""}`
    const pending = pageInflight.get(key)
    if (pending) return pending
    const child = deps.child(directory)
    const directoryRevision = deps.revision(directory)
    const started = performance.now()
    markSessionProfile(
      input.sessionID,
      "messages-request-start",
      `limit=${String(input.limit)} before=${input.before ?? "none"}`,
    )
    const promise = retry(() =>
      deps.sdk(directory).session.messages({ sessionID: input.sessionID, limit: input.limit, before: input.before }),
    )
      .then((response) => {
        if (!deps.current(directory, child, directoryRevision)) {
          const error = new Error("Session message request became stale after directory reset")
          error.name = "AbortError"
          throw error
        }
        const items = (response.data ?? []).filter((item) => !!item?.info?.id)
        const messages = items.map((item) => item.info).sort((a, b) => compareSessionItemID(a.id, b.id))
        const cursor = response.response.headers.get("x-next-cursor") ?? undefined
        markSessionProfile(
          input.sessionID,
          "messages-request-end",
          `duration_ms=${String(Math.round((performance.now() - started) * 10) / 10)} count=${String(messages.length)}`,
        )
        return {
          session: messages,
          part: items.map((item) => ({ id: item.info.id, part: sortSessionParts(item.parts) })),
          cursor,
          complete: !cursor,
        } satisfies SessionMessagePage
      })
      .finally(() => {
        if (pageInflight.get(key) === promise) pageInflight.delete(key)
      })
    pageInflight.set(key, promise)
    return promise
  }

  const load = (input: {
    directory: string
    sessionID: string
    limit: number
    before?: string
    mode?: "replace" | "prepend"
  }): Promise<LoadResult> => {
    const directory = deps.canonical(input.directory)
    const key = keyFor(directory, input.sessionID)
    const pending = inflight.get(key)
    if (pending) return pending
    const child = deps.child(directory)
    const directoryRevision = deps.revision(directory)
    const eventRevision = rev(directory, input.sessionID)
    const discardMark = discardRevision.get(key) ?? 0
    const requestGeneration = (generation.get(key) ?? 0) + 1
    generation.set(key, requestGeneration)
    setActivity("loading", key, (value) => (value ?? 0) + 1)
    const promise = page(input)
      .then((result) => {
        if (!deps.current(directory, child, directoryRevision)) {
          return { committed: false, count: child[0].message[input.sessionID]?.length ?? 0, complete: false }
        }
        const history = child[0].session_history?.[input.sessionID]
        if (generation.get(key) !== requestGeneration || (discardRevision.get(key) ?? 0) !== discardMark) {
          return {
            committed: false,
            count: child[0].message[input.sessionID]?.length ?? 0,
            cursor: history?.cursor,
            complete: history?.complete ?? false,
          }
        }

        const next = mergeOptimisticSessionPage(result, optimisticItems(directory, input.sessionID))
        for (const messageID of next.confirmed) clearOptimistic(directory, input.sessionID, messageID)
        const eventChanged = rev(directory, input.sessionID) !== eventRevision
        const cached = child[0].message[input.sessionID] ?? []
        const messages = input.mode === "prepend" || eventChanged ? mergeSessionItems(next.session, cached) : next.session
        batch(() => {
          child[1]("message", input.sessionID, reconcile(messages, { key: "id" }))
          for (const item of next.part) {
            const fetched = item.part.filter((part) => !SESSION_MESSAGE_SKIP_PARTS.has(part.type))
            const current = child[0].part[item.id]
            const parts = eventChanged
              ? mergeSessionItems(fetched, current ?? [])
              : mergeFetchedSessionParts(fetched, current)
            if (parts.length) child[1]("part", item.id, reconcileFetchedSessionParts(parts))
          }
          child[1]("session_history", input.sessionID, {
            cursor: next.cursor,
            complete: next.complete,
            show: history?.show,
            at: Date.now(),
          })
          setSessionPrefetch({
            directory,
            sessionID: input.sessionID,
            count: messages.length,
            cursor: next.cursor,
            complete: next.complete,
          })
        })
        return { committed: true, count: messages.length, cursor: next.cursor, complete: next.complete }
      })
      .finally(() => {
        const current = inflight.get(key)
        if (current && current !== promise) return
        if (current === promise) inflight.delete(key)
        setActivity(
          "loading",
          produce((items) => {
            delete items[key]
          }),
        )
        if (!inflight.has(key) && !optimistic.has(key)) {
          revision.delete(key)
          discardRevision.delete(key)
          generation.delete(key)
        }
      })
    inflight.set(key, promise)
    return promise
  }

  const addOptimistic = (directory: string, input: { sessionID: string; message: Message; parts: Part[] }) => {
    directory = deps.canonical(directory)
    const key = keyFor(directory, input.sessionID)
    const items = optimistic.get(key)
    const value = { message: input.message, parts: sortSessionParts(input.parts) }
    if (items) items.set(input.message.id, value)
    else optimistic.set(key, new Map([[input.message.id, value]]))
    const child = deps.child(directory)
    const messages = child[0].message[input.sessionID] ?? []
    const result = Binary.search(messages, input.message.id, (message) => message.id)
    if (!result.found) {
      const next = [...messages]
      next.splice(result.index, 0, input.message)
      child[1]("message", input.sessionID, reconcile(next, { key: "id" }))
    }
    child[1]("part", input.message.id, sortSessionParts(input.parts))
  }

  const removeOptimistic = (directory: string, input: { sessionID: string; messageID: string }) => {
    directory = deps.canonical(directory)
    clearOptimistic(directory, input.sessionID, input.messageID)
    const child = deps.child(directory)
    const messages = child[0].message[input.sessionID]
    if (messages) {
      const result = Binary.search(messages, input.messageID, (message) => message.id)
      if (result.found) {
        const next = [...messages]
        next.splice(result.index, 1)
        child[1]("message", input.sessionID, reconcile(next, { key: "id" }))
      }
    }
    child[1]("part", (parts: Record<string, Part[] | undefined>) => {
      if (!(input.messageID in parts)) return parts
      const next = { ...parts }
      delete next[input.messageID]
      return next
    })
  }

  return {
    get(directory: string, sessionID: string) {
      return deps.child(deps.canonical(directory))[0].message[sessionID]
    },
    parts(directory: string, messageID: string) {
      return deps.child(deps.canonical(directory))[0].part[messageID]
    },
    page,
    load,
    loading(directory: string, sessionID: string) {
      return (activity.loading[keyFor(directory, sessionID)] ?? 0) > 0
    },
    history(directory: string, sessionID: string) {
      return deps.child(deps.canonical(directory))[0].session_history?.[sessionID]
    },
    setShow(directory: string, sessionID: string, show: number | undefined) {
      const child = deps.child(deps.canonical(directory))
      const history = child[0].session_history?.[sessionID]
      if (history) child[1]("session_history", sessionID, { ...history, show })
    },
    optimistic: {
      add: addOptimistic,
      complete(directory: string, input: { sessionID: string; messageID: string }) {
        directory = deps.canonical(directory)
        clearOptimistic(directory, input.sessionID, input.messageID)
        const [, setStore] = deps.child(directory)
        setStore("part", input.messageID, (parts: Part[]) =>
          parts.filter(
            (part) =>
              !(part.type === "text" && part.synthetic && part.metadata?.kind === "command-injection" && part.metadata.pending === true),
          ),
        )
      },
      remove: removeOptimistic,
    },
    event(directory: string, sessionID: string, strategy: "merge" | "discard") {
      bump(directory, sessionID)
      if (strategy === "discard") {
        const key = keyFor(directory, sessionID)
        discardRevision.set(key, (discardRevision.get(key) ?? 0) + 1)
      }
    },
    clear(directory: string, sessionIDs: string[]) {
      directory = deps.canonical(directory)
      for (const sessionID of sessionIDs) {
        const key = keyFor(directory, sessionID)
        const pending = inflight.get(key)
        generation.set(key, (generation.get(key) ?? 0) + 1)
        revision.set(key, (revision.get(key) ?? 0) + 1)
        inflight.delete(key)
        optimistic.delete(key)
        for (const pageKey of pageInflight.keys()) {
          if (pageKey.startsWith(`${key}\n`)) pageInflight.delete(pageKey)
        }
        setActivity(
          "loading",
          produce((items) => {
            delete items[key]
          }),
        )
        if (!pending) {
          revision.delete(key)
          discardRevision.delete(key)
          generation.delete(key)
        }
      }
    },
    clearDirectory(directory: string) {
      const prefix = `${deps.canonical(directory)}\n`
      const clear = (map: { keys(): IterableIterator<string>; delete(key: string): boolean }) => {
        for (const key of map.keys()) {
          if (key.startsWith(prefix)) map.delete(key)
        }
      }
      clear(revision)
      clear(discardRevision)
      clear(generation)
      clear(pageInflight)
      clear(inflight)
      clear(optimistic)
      setActivity("loading", (items) => {
        const next = { ...items }
        for (const key of Object.keys(next)) {
          if (key.startsWith(prefix)) delete next[key]
        }
        return next
      })
    },
    inspect() {
      return {
        revision: revision.size,
        discardRevision: discardRevision.size,
        generation: generation.size,
        pageInflight: pageInflight.size,
        inflight: inflight.size,
        optimistic: optimistic.size,
        loading: Object.keys(activity.loading).length,
      }
    },
  }
}
