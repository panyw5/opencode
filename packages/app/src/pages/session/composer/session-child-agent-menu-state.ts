import { createEffect, createMemo, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { SessionChildAgentEntry } from "../session-child-agents"

export function createChildAgentMenuEntries(source: Accessor<SessionChildAgentEntry[]>) {
  const [entries, setEntries] = createStore<SessionChildAgentEntry[]>([])
  createEffect(() => {
    // Keep mounted menu items (and their focus/scroll state) across live snapshots.
    setEntries(
      reconcile(
        source().toSorted((a, b) => b.created - a.created),
        { key: "id" },
      ),
    )
  })
  return entries
}

export function createChildAgentMenuGroups(entries: SessionChildAgentEntry[]) {
  return (["running", "completed", "error", "unknown"] as const).map((status) => ({
    status,
    entries: createMemo(() => entries.filter((entry) => (entry.status ?? "unknown") === status)),
  }))
}
