import type { Part, UserMessage } from "@opencode-ai/sdk/v2"
import { createStore } from "solid-js/store"

export type PendingSessionSubmission = {
  key: string
  directory: string
  draftID?: string
  message: UserMessage
  parts: Part[]
  phase: "preparing" | "sending" | "failed"
  sessionID?: string
  sessionDirectory?: string
  error?: string
  retry: () => void
  edit: () => void
}

const [entries, setEntries] = createStore<Record<string, PendingSessionSubmission | undefined>>({})

export const pendingSessionKey = (server: string, directory: string, draftID?: string) =>
  JSON.stringify([server, directory, draftID])

export const pendingSessionSubmissions = {
  entries,
  get(server: string, directory: string, route: { id?: string; draftID?: string }) {
    return Object.values(entries).find((entry) => {
      if (!entry || entry.key !== pendingSessionKey(server, entry.directory, entry.draftID)) return false
      if (route.id) return entry.sessionID === route.id && entry.sessionDirectory === directory
      return entry.directory === directory && entry.draftID === route.draftID
    })
  },
  begin(entry: PendingSessionSubmission) {
    if (entries[entry.key]) return false
    console.debug(`[new-session-submit] begin key=${entry.key} message=${entry.message.id}`)
    setEntries(entry.key, entry)
    return true
  },
  retry(key: string) {
    if (entries[key]?.phase !== "failed") return false
    console.debug(`[new-session-submit] retry key=${key}`)
    setEntries(key, { phase: "preparing", error: undefined })
    return true
  },
  promote(key: string, directory: string, sessionID: string) {
    if (!entries[key]) return
    console.debug(`[new-session-submit] promote key=${key} session=${sessionID} directory=${directory}`)
    setEntries(key, { sessionID, sessionDirectory: directory, phase: "sending", error: undefined })
  },
  fail(key: string, error: string) {
    if (!entries[key]) return
    console.warn(`[new-session-submit] failed key=${key} error=${error}`)
    setEntries(key, { phase: "failed", error })
  },
  finish(key: string) {
    if (!entries[key]) return
    console.debug(`[new-session-submit] finish key=${key}`)
    setEntries(key, undefined)
  },
}
