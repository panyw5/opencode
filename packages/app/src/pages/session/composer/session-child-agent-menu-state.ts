import { createEffect, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { SessionChildAgentEntry } from "../session-child-agents"

export function createChildAgentMenuEntries(source: Accessor<SessionChildAgentEntry[]>) {
  const [entries, setEntries] = createStore<SessionChildAgentEntry[]>([])
  createEffect(() => {
    // Keep mounted menu items (and their focus/scroll state) across live snapshots.
    setEntries(reconcile(source(), { key: "id" }))
  })
  return entries
}
