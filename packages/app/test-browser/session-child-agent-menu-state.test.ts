import { expect, test } from "bun:test"
import { createRoot, createSignal, mapArray, onCleanup } from "solid-js"
import { createChildAgentMenuEntries } from "../src/pages/session/composer/session-child-agent-menu-state"
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
