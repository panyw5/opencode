import type { Session } from "@opencode-ai/sdk/v2/client"
import { createStore, produce } from "solid-js/store"
import type { SessionControllerDeps } from "./session-service-types"
import type { createSessionInfoService } from "./session-info-service"
import type { createSessionMessagesService } from "./session-messages-service"
import type { createSessionStatusService } from "./session-status-service"

type Phase = "stopping" | "mutating" | "reconciling" | "uncertain"
type Operation = { messageID?: string; phase: Phase }
const missing = (error: unknown) => {
  if (!error || typeof error !== "object") return false
  if ("name" in error && error.name === "NotFoundError") return true
  const cause =
    "cause" in error ? (error.cause as { status?: number; body?: { name?: string } } | undefined) : undefined
  return cause?.status === 404 && cause.body?.name === "NotFoundError"
}
const checked = <T>(result: { data?: T; error?: unknown }): T => {
  if (result.error) throw result.error
  if (result.data === undefined) throw new Error("Session history response has no data")
  return result.data
}

export function createSessionHistoryService(
  deps: SessionControllerDeps,
  services: {
    info: ReturnType<typeof createSessionInfoService>
    messages: ReturnType<typeof createSessionMessagesService>
    status: ReturnType<typeof createSessionStatusService>
  },
) {
  const [state, setState] = createStore({ operations: {} as Record<string, Operation | undefined> })
  const inflight = new Map<string, Promise<Session>>()
  const sends = new Map<string, Set<Promise<unknown>>>()
  const keyFor = (directory: string, sessionID: string) => `${deps.key(directory)}\n${sessionID}`
  const log = (directory: string, sessionID: string, stage: string) =>
    console.debug(`[session-history] directory=${directory} sid=${sessionID} stage=${stage}`)

  const reconcile = async (directory: string, sessionID: string) => {
    const child = deps.child(directory)
    const revision = deps.revision(directory)
    log(directory, sessionID, "reconcile-start")
    // Status refresh can reconcile stale assistant messages itself. Complete
    // it before requesting the authoritative history snapshot.
    await services.status.refresh(directory, "manual", { strict: true })
    if (!deps.current(directory, child, revision)) throw new Error("Session history reconciliation was invalidated")
    // Do not join a metadata read started before the history mutation.
    services.info.clear(directory, [sessionID])
    const [session, messages] = await Promise.all([
      services.info.refresh(directory, sessionID),
      (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!deps.current(directory, child, revision)) return
          const result = await services.messages.load({
            directory,
            sessionID,
            limit: 80,
            mode: "replace",
            authoritative: true,
          })
          if (result.committed) return result
          log(directory, sessionID, `snapshot-superseded attempt=${attempt + 1}`)
        }
      })(),
    ])
    if (!session || !messages?.committed) throw new Error("Session history reconciliation was invalidated")
    log(directory, sessionID, "reconcile-confirmed")
    return session
  }

  const change = (directory: string, input: { sessionID: string; messageID?: string }): Promise<Session> => {
    const key = keyFor(directory, input.sessionID)
    const pending = inflight.get(key)
    if (pending) {
      if (state.operations[key]?.messageID === input.messageID) return pending
      return Promise.reject(new Error("Another session history operation is in progress"))
    }
    const child = deps.child(directory)
    const revision = deps.revision(directory)
    const current = () => deps.current(directory, child, revision) && inflight.get(key) === promise
    const phase = (phase: Phase) => {
      if (!current()) throw new Error("Session history operation belongs to a previous backend")
      setState("operations", key, { messageID: input.messageID, phase })
      log(directory, input.sessionID, phase)
    }
    deps.pin(directory)
    setState("operations", key, { messageID: input.messageID, phase: "stopping" })
    const stop = async () => {
      if (checked(await deps.sdk(directory).session.abort({ sessionID: input.sessionID })) !== true) {
        throw new Error("Sidecar did not confirm stopping the session")
      }
    }
    const promise = Promise.resolve().then(async () => {
      let reconciled = false
      let missingTarget = false
      try {
        if (sends.get(key)?.size) await stop()
        await Promise.allSettled([...(sends.get(key) ?? [])])
        phase("stopping")
        // Local busy state is not proof of backend idleness or completed admission.
        await stop()
        phase("mutating")
        const session = await (async () => {
          try {
            return checked(
              input.messageID
                ? await deps.sdk(directory).session.revert({ sessionID: input.sessionID, messageID: input.messageID })
                : await deps.sdk(directory).session.unrevert({ sessionID: input.sessionID }),
            )
          } catch (error) {
            missingTarget = !!input.messageID && missing(error)
            throw error
          }
        })()
        const valid =
          session.id === input.sessionID &&
          (input.messageID ? session.revert?.messageID === input.messageID && !session.revert.partID : !session.revert)
        if (!valid) {
          log(
            directory,
            input.sessionID,
            `invalid-response requested=${input.messageID ?? "none"} actual=${session.revert?.messageID ?? "none"}`,
          )
          // A bad success response is not evidence that a message can be deleted.
          if (input.messageID) {
            try {
              checked(
                await deps.sdk(directory).session.message({ sessionID: input.sessionID, messageID: input.messageID }),
              )
            } catch (error) {
              missingTarget = missing(error)
              throw error
            }
          }
          throw new Error("Sidecar did not confirm the requested session history boundary")
        }
        phase("reconciling")
        const actual = await reconcile(directory, input.sessionID)
        if (!current()) throw new Error("Session history operation was invalidated")
        reconciled = true
        if (
          actual.id !== input.sessionID ||
          (actual.revert?.messageID ?? undefined) !== input.messageID ||
          actual.revert?.partID
        ) {
          throw new Error("Session history changed concurrently; refreshed to the server state")
        }
        log(directory, input.sessionID, "confirmed")
        return actual
      } catch (error) {
        if (!current()) throw error
        if (missingTarget && input.messageID) {
          services.messages.optimistic.remove(directory, { sessionID: input.sessionID, messageID: input.messageID })
          log(directory, input.sessionID, `missing-message-removed message=${input.messageID}`)
        }
        if (!reconciled) {
          phase("reconciling")
          try {
            await reconcile(directory, input.sessionID)
            reconciled = true
          } catch (refreshError) {
            console.warn(
              `[session-history] sid=${input.sessionID} stage=reconcile-failed error=${String(refreshError)}`,
            )
          }
        }
        console.warn(
          `[session-history] sid=${input.sessionID} stage=failed reconciled=${reconciled} error=${String(error)}`,
        )
        throw error
      } finally {
        if (inflight.get(key) === promise) {
          const valid = deps.current(directory, child, revision)
          inflight.delete(key)
          if (reconciled || !valid)
            setState(
              "operations",
              produce((draft) => {
                delete draft[key]
              }),
            )
          else setState("operations", key, { messageID: input.messageID, phase: "uncertain" })
        }
        deps.unpin(directory)
      }
    })
    inflight.set(key, promise)
    return promise
  }

  return {
    change,
    pending(directory: string, sessionID: string) {
      const operation = state.operations[keyFor(directory, sessionID)]
      return !!operation && operation.phase !== "uncertain"
    },
    operation(directory: string, sessionID: string) {
      return state.operations[keyFor(directory, sessionID)]
    },
    async send<T>(directory: string, sessionID: string, request: () => Promise<T>) {
      const key = keyFor(directory, sessionID)
      const child = deps.child(directory)
      const revision = deps.revision(directory)
      if (inflight.has(key)) throw new Error("Wait for the session history operation before sending")
      if (state.operations[key]?.phase === "uncertain") {
        await reconcile(directory, sessionID)
        if (inflight.has(key)) throw new Error("Session history changed while reconciling")
        setState(
          "operations",
          produce((draft) => {
            delete draft[key]
          }),
        )
      }
      const pending = Promise.resolve().then(() => {
        if (!deps.current(directory, child, revision)) throw new Error("Session send belongs to a previous backend")
        return request()
      })
      const active = sends.get(key) ?? new Set<Promise<unknown>>()
      active.add(pending)
      sends.set(key, active)
      try {
        return await pending
      } finally {
        active.delete(pending)
        if (!active.size && sends.get(key) === active) sends.delete(key)
      }
    },
    clear(directory: string, sessionIDs: string[]) {
      for (const sessionID of sessionIDs) {
        const key = keyFor(directory, sessionID)
        inflight.delete(key)
        sends.delete(key)
        setState(
          "operations",
          produce((draft) => {
            delete draft[key]
          }),
        )
      }
    },
    clearDirectory(directory: string) {
      const prefix = `${deps.key(directory)}\n`
      for (const key of new Set([...inflight.keys(), ...sends.keys(), ...Object.keys(state.operations)])) {
        if (!key.startsWith(prefix)) continue
        inflight.delete(key)
        sends.delete(key)
        setState(
          "operations",
          produce((draft) => {
            delete draft[key]
          }),
        )
      }
    },
  }
}
