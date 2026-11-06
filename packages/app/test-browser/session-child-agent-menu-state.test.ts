import { expect, test } from "bun:test"
import { createRoot, createSignal, mapArray, onCleanup } from "solid-js"
import {
  createChildAgentMenuEntries,
  createChildAgentMenuGroups,
} from "../src/pages/session/composer/session-child-agent-menu-state"
import type { SessionChildAgentEntry } from "../src/pages/session/session-child-agents"

const entry = (id: string): SessionChildAgentEntry => ({
  id,
  sessionID: `session-${id}`,
  title: `Child ${id}`,
  created: 1,
  status: "running",
  background: true,
})

function harness(initial: SessionChildAgentEntry[]) {
  return createRoot((dispose) => {
    const [source, update] = createSignal(initial)
    const entries = createChildAgentMenuEntries(source)
    const removed: string[] = []
    let mounts = 0
    // For uses mapArray too: replacing a row here remounts its menu item in the UI.
    const rows = mapArray(
      () => entries,
      (entry) => {
        mounts += 1
        onCleanup(() => removed.push(entry.id))
        return { entry, select: () => entry.sessionID }
      },
    )
    return { dispose, update, entries, rows, removed, mounts: () => mounts }
  })
}

test("unchanged live snapshots keep every child menu item mounted", () => {
  const h = harness(Array.from({ length: 24 }, (_, i) => entry(String(i))))
  try {
    const before = [...h.rows()]
    for (let i = 0; i < 10; i++) {
      h.update(Array.from({ length: 24 }, (_, i) => entry(String(i))))
      expect(h.rows().every((row, index) => row === before[index])).toBe(true)
    }
    expect(h.mounts()).toBe(24)
    expect(h.removed).toEqual([])
  } finally {
    h.dispose()
  }
})

test("status, title and selection data update without replacing a menu item", () => {
  const h = harness([entry("a"), entry("b")])
  try {
    const before = [...h.rows()]
    h.update([
      {
        ...entry("a"),
        title: "Renamed child",
        sessionID: "latest-session",
        status: "completed",
        background: undefined,
      },
      entry("b"),
    ])
    expect(h.rows()[0]).toBe(before[0])
    expect(before[0].entry.title).toBe("Renamed child")
    expect(before[0].entry.status).toBe("completed")
    expect(before[0].entry.background).toBeUndefined()
    expect(before[0].select()).toBe("latest-session")
    expect(h.mounts()).toBe(2)
    expect(h.removed).toEqual([])
  } finally {
    h.dispose()
  }
})

test("child menu entries sort newest first without changing the source or session indices", () => {
  const initial = [
    { ...entry("old"), created: 1, index: 1 },
    { ...entry("new"), created: 3, index: 3 },
    { ...entry("middle"), created: 2, index: 2 },
  ]
  const h = harness(initial)
  try {
    expect(h.rows().map((row) => row.entry.id)).toEqual(["new", "middle", "old"])
    expect(h.rows().map((row) => row.entry.index)).toEqual([3, 2, 1])
    expect(initial.map((item) => item.id)).toEqual(["old", "new", "middle"])
    const before = [...h.rows()]
    h.update([...initial, { ...entry("latest"), created: 4 }])
    expect(h.rows().map((row) => row.entry.id)).toEqual(["latest", "new", "middle", "old"])
    expect(h.rows().slice(1)).toEqual(before)
    expect(h.mounts()).toBe(4)
    expect(h.removed).toEqual([])
  } finally {
    h.dispose()
  }
})

test("child menu entries retain source order for matching timestamps", () => {
  const h = harness([entry("a"), entry("b"), entry("c")])
  try {
    expect(h.rows().map((row) => row.entry.id)).toEqual(["a", "b", "c"])
  } finally {
    h.dispose()
  }
})

test("child menu groups put running before completed and preserve other statuses", () => {
  const h = createRoot((dispose) => {
    const [entries, setEntries] = createSignal<SessionChildAgentEntry[]>([
      { ...entry("completed-old"), created: 1, status: "completed" },
      { ...entry("unknown"), created: 5, status: undefined },
      { ...entry("running-old"), created: 2 },
      { ...entry("failed"), created: 6, status: "error" },
      { ...entry("completed-new"), created: 4, status: "completed" },
      { ...entry("running-new"), created: 3 },
      { ...entry("explicit-unknown"), created: 7, status: "unknown" },
    ])
    const sorted = createChildAgentMenuEntries(entries)
    const groups = createChildAgentMenuGroups(sorted)
    const visible = () =>
      groups
        .filter((group) => group.entries().length > 0)
        .map((group) => ({
          status: group.status,
          ids: group.entries().map((item) => item.id),
        }))
    return { visible, setEntries, dispose }
  })
  try {
    expect(h.visible()).toEqual([
      { status: "running", ids: ["running-new", "running-old"] },
      { status: "completed", ids: ["completed-new", "completed-old"] },
      { status: "error", ids: ["failed"] },
      { status: "unknown", ids: ["explicit-unknown", "unknown"] },
    ])
    h.setEntries((current) =>
      current.map((item) => (item.status === "running" ? { ...item, status: "completed" } : item)),
    )
    expect(h.visible()).toEqual([
      { status: "completed", ids: ["completed-new", "running-new", "running-old", "completed-old"] },
      { status: "error", ids: ["failed"] },
      { status: "unknown", ids: ["explicit-unknown", "unknown"] },
    ])
    h.setEntries([])
    expect(h.visible()).toEqual([])
  } finally {
    h.dispose()
  }
})

test("reordering and replacing entries preserves only matching IDs, not array positions", () => {
  const h = harness([entry("a"), entry("b"), entry("c")])
  try {
    const before = [...h.rows()]
    h.update([entry("c"), entry("d"), entry("a")])
    const after = h.rows()
    expect(after[0]).toBe(before[2])
    expect(after[2]).toBe(before[0])
    expect(after[1].entry.id).toBe("d")
    expect(h.mounts()).toBe(4)
    expect(h.removed).toEqual(["b"])
    h.update([])
    expect(h.rows()).toEqual([])
  } finally {
    h.dispose()
  }
})
