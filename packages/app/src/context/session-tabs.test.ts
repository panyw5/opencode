import { describe, expect, test } from "bun:test"
import type { SessionBarTab } from "./layout"
import {
  createSessionTabsCoordinator,
  planSessionTabClose,
  type SessionTabsRoute,
  type SessionTabsPorts,
  type SessionTabsTarget,
} from "./session-tabs"

const tab = (id: string, directory = "/repo", parentID?: string): SessionBarTab => ({ directory, id, parentID })

function harness(input?: { tabs?: SessionBarTab[]; drafts?: string[]; route?: SessionTabsRoute; timeoutMs?: number }) {
  let tabs = [...(input?.tabs ?? [])]
  let drafts = [...(input?.drafts ?? [])]
  let route = input?.route ?? ({ directory: "/repo", session: true } satisfies SessionTabsRoute)
  let failPrepare = false
  const prepareQueue: Promise<void>[] = []
  const targets: SessionTabsTarget[] = []
  const cooled: string[][] = []
  const viewed: string[] = []
  const remembered: string[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const ports: SessionTabsPorts = {
    store: {
      all: () => tabs,
      drafts: () => drafts,
      open(value) {
        const index = tabs.findIndex((item) => item.directory === value.directory && item.id === value.id)
        if (index >= 0) tabs[index] = { ...tabs[index], ...value }
        else tabs.push(value)
      },
      closeAll(values) {
        const closing = new Set(values.map((item) => `${item.directory}:${item.id}`))
        tabs = tabs.filter((item) => !closing.has(`${item.directory}:${item.id}`))
      },
      openDraft(directory) {
        if (!drafts.includes(directory)) drafts.push(directory)
      },
      closeDraft(directory) {
        drafts = drafts.filter((item) => item !== directory)
      },
      setInfo(directory, id, info) {
        tabs = tabs.map((item) => (item.directory === directory && item.id === id ? { ...item, ...info } : item))
      },
    },
    route: () => route,
    parentID: (value) => value.parentID ?? undefined,
    async prepare() {
      if (failPrepare) throw new Error("prepare failed")
      const next = prepareQueue.shift()
      if (next) await next
    },
    navigate(target) {
      targets.push(target)
    },
    cool(values) {
      cooled.push(values.map((item) => item.id))
    },
    markViewed(id) {
      viewed.push(id)
    },
    remember(directory, id, root) {
      remembered.push(`${directory}:${id}:${root ?? ""}`)
    },
    closeTimeoutMs: input?.timeoutMs,
    scheduleTimeout(run, ms) {
      const timer = setTimeout(run, ms)
      timers.add(timer)
      return timer
    },
    cancelTimeout(timer) {
      clearTimeout(timer)
      timers.delete(timer)
    },
  }
  const coordinator = createSessionTabsCoordinator(ports)

  return {
    coordinator,
    remount: () => createSessionTabsCoordinator(ports),
    tabs: () => tabs,
    drafts: () => drafts,
    targets,
    cooled,
    viewed,
    remembered,
    setRoute(value: SessionTabsRoute) {
      route = value
    },
    setFailPrepare(value: boolean) {
      failPrepare = value
    },
    queuePrepare(value: Promise<void>) {
      prepareQueue.push(value)
    },
    dispose() {
      coordinator.dispose()
      for (const timer of timers) clearTimeout(timer)
    },
  }
}

describe("session tabs coordinator", () => {
  test("route observation ensures one tab without requiring a project root", () => {
    const h = harness()
    const route = { directory: "/repo", id: "one", session: true }
    h.coordinator.observeRoute(route, { title: "One" })
    h.coordinator.observeRoute(route, { title: "Updated", root: "/repo" })
    expect(h.tabs()).toEqual([{ directory: "/repo", id: "one", title: "Updated", parentID: undefined }])
    expect(h.viewed).toEqual(["one", "one"])
    expect(h.remembered).toEqual(["/repo:one:", "/repo:one:/repo"])
    h.dispose()
  })

  test("opening a child creates its available parent through the coordinator", () => {
    const h = harness({ route: { directory: "/parent-open", session: true } })

    h.coordinator.ensureOpen(tab("child", "/parent-open", "parent"))

    expect(h.tabs()).toEqual([
      { directory: "/parent-open", id: "parent" },
      { directory: "/parent-open", id: "child", parentID: "parent" },
    ])
    h.dispose()
  })

  test("metadata cannot recreate a tombstoned parent", async () => {
    const directory = "/parent-tombstone"
    const parent = tab("parent", directory)
    const child = tab("child", directory)
    const h = harness({
      tabs: [child],
      route: { directory, id: child.id, session: true },
    })

    await h.coordinator.remove(parent, "archived")
    h.coordinator.updateMeta(directory, child.id, { parentID: parent.id })

    expect(h.tabs()).toEqual([{ directory, id: child.id, parentID: parent.id }])
    h.dispose()
  })

  test("metadata for an already closed child cannot create its parent", () => {
    const h = harness({ route: { directory: "/closed-child", session: true } })

    h.coordinator.updateMeta("/closed-child", "child", { parentID: "parent" })

    expect(h.tabs()).toEqual([])
    h.dispose()
  })

  test("reopening a workspace clears only its workspace removal tombstones", async () => {
    const directory = "/workspace-reopen"
    const victim = tab("workspace-session", directory)
    const h = harness({
      tabs: [victim],
      route: { directory, id: victim.id, session: true },
    })

    await h.coordinator.removeDirectory(directory, { navigate: false })
    h.coordinator.ensureOpen(victim)
    expect(h.tabs()).toEqual([])

    h.coordinator.restoreDirectory(directory)
    h.coordinator.ensureOpen(victim)
    expect(h.tabs()).toEqual([victim])
    h.dispose()
  })

  test("reopening a workspace preserves archived session tombstones", async () => {
    const directory = "/workspace-archived"
    const victim = tab("archived-session", directory)
    const h = harness({
      tabs: [victim],
      route: { directory, session: true },
    })

    await h.coordinator.remove(victim, "archived")
    h.coordinator.restoreDirectory(directory)
    h.coordinator.ensureOpen(victim)

    expect(h.tabs()).toEqual([])
    h.dispose()
  })

  test("workspace reopen uses canonical directory aliases", async () => {
    const victim = tab("aliased-session", "/private/tmp/workspace-alias")
    const h = harness({
      tabs: [victim],
      route: { directory: "/tmp/workspace-alias", id: victim.id, session: true },
    })

    await h.coordinator.removeDirectory("/tmp/workspace-alias", { navigate: false })
    h.coordinator.restoreDirectory("/tmp/workspace-alias")
    h.coordinator.ensureOpen(victim)

    expect(h.tabs()).toEqual([victim])
    h.dispose()
  })

  test("confirmed deletion upgrades a workspace tombstone before reopen", async () => {
    const directory = "/workspace-deleted"
    const victim = tab("deleted-session", directory)
    const h = harness({
      tabs: [victim],
      route: { directory, session: true },
    })

    await h.coordinator.removeDirectory(directory, { navigate: false })
    const epoch = h.coordinator.beginReconcile(directory)
    await h.coordinator.reconcileDirectory({
      directory,
      epoch,
      entries: [{ tab: victim, state: "deleted" }],
    })
    h.coordinator.restoreDirectory(directory)
    h.coordinator.ensureOpen(victim)

    expect(h.tabs()).toEqual([])
    h.dispose()
  })

  test("authoritative reconciliation removes confirmed missing tabs and retains unknown tabs", async () => {
    const directory = "/reconcile"
    const missing = tab("missing", directory)
    const unknown = tab("unknown", directory)
    const h = harness({
      tabs: [missing, unknown],
      route: { directory, session: true },
    })
    const epoch = h.coordinator.beginReconcile(directory)

    expect(
      await h.coordinator.reconcileDirectory({
        directory,
        epoch,
        entries: [
          { tab: missing, state: "deleted" },
          { tab: unknown, state: "unknown" },
        ],
      }),
    ).toBe(true)

    expect(h.tabs()).toEqual([unknown])
    h.dispose()
  })

  test("reconciliation updates confirmed entries without pruning omitted paginated entries", async () => {
    const directory = "/reconcile-partial"
    const present = { ...tab("present", directory), title: "Old" }
    const omitted = tab("omitted", directory)
    const h = harness({
      tabs: [present, omitted],
      route: { directory, session: true },
    })
    const epoch = h.coordinator.beginReconcile(directory)

    expect(
      await h.coordinator.reconcileDirectory({
        directory,
        epoch,
        entries: [{ tab: { ...present, title: "Updated" }, state: "present" }],
      }),
    ).toBe(true)

    expect(h.tabs()).toEqual([{ ...present, title: "Updated", parentID: null }, omitted])
    h.dispose()
  })

  test("a late present reconciliation cannot clear a newer archive tombstone", async () => {
    const directory = "/reconcile-late-present"
    const victim = tab("victim", directory)
    const h = harness({
      tabs: [victim],
      route: { directory, session: true },
    })
    const epoch = h.coordinator.beginReconcile(directory)

    await h.coordinator.remove(victim, "archived")
    await h.coordinator.reconcileDirectory({
      directory,
      epoch,
      entries: [{ tab: victim, state: "present" }],
    })
    h.coordinator.ensureOpen(victim)

    expect(h.tabs()).toEqual([])
    h.dispose()
  })

  test("a stale reconciliation epoch cannot remove tabs", async () => {
    const directory = "/reconcile-epoch"
    const victim = tab("victim", directory)
    const h = harness({
      tabs: [victim],
      route: { directory, session: true },
    })
    const stale = h.coordinator.beginReconcile(directory)
    const current = h.coordinator.beginReconcile(directory)

    expect(
      await h.coordinator.reconcileDirectory({
        directory,
        epoch: stale,
        entries: [{ tab: victim, state: "deleted" }],
      }),
    ).toBe(false)
    expect(h.tabs()).toEqual([victim])

    expect(
      await h.coordinator.reconcileDirectory({
        directory,
        epoch: current,
        entries: [{ tab: victim, state: "deleted" }],
      }),
    ).toBe(true)
    expect(h.tabs()).toEqual([])
    h.dispose()
  })

  test("reconciliation only applies entries from its directory", async () => {
    const kept = tab("kept", "/reconcile-a")
    const h = harness({
      tabs: [kept],
      route: { directory: "/reconcile-a", session: true },
    })
    const epoch = h.coordinator.beginReconcile("/reconcile-b")

    expect(
      await h.coordinator.reconcileDirectory({
        directory: "/reconcile-b",
        epoch,
        entries: [{ tab: kept, state: "deleted" }],
      }),
    ).toBe(true)
    expect(h.tabs()).toEqual([kept])
    h.dispose()
  })

  test("a newer activation prevents an older prepared target from navigating late", async () => {
    const h = harness({
      tabs: [tab("one"), tab("two"), tab("three")],
      route: { directory: "/repo", id: "three", session: true },
    })
    let release!: () => void
    h.queuePrepare(new Promise<void>((resolve) => (release = resolve)))
    const first = h.coordinator.activate({ type: "session", directory: "/repo", id: "one" })

    expect(await h.coordinator.activate({ type: "session", directory: "/repo", id: "two" })).toBe(true)
    expect(h.targets).toEqual([{ type: "session", directory: "/repo", id: "two" }])

    release()
    expect(await first).toBe(false)
    expect(h.targets).toEqual([{ type: "session", directory: "/repo", id: "two" }])
    h.dispose()
  })

  test("closing a pending activation target prevents it from reopening late", async () => {
    const h = harness({
      tabs: [tab("one"), tab("two")],
      route: { directory: "/repo", id: "two", session: true },
    })
    let release!: () => void
    h.queuePrepare(new Promise<void>((resolve) => (release = resolve)))
    const activation = h.coordinator.activate({ type: "session", directory: "/repo", id: "one" })

    expect(await h.coordinator.requestClose(tab("one"))).toBe(true)
    expect(h.tabs().map((item) => item.id)).toEqual(["two"])

    release()
    expect(await activation).toBe(false)
    expect(h.targets).toEqual([])
    expect(h.tabs().map((item) => item.id)).toEqual(["two"])
    h.dispose()
  })

  test("closing an unrelated background tab keeps the pending activation", async () => {
    const h = harness({
      tabs: [tab("one"), tab("two"), tab("three")],
      route: { directory: "/repo", id: "three", session: true },
    })
    let release!: () => void
    h.queuePrepare(new Promise<void>((resolve) => (release = resolve)))
    const activation = h.coordinator.activate({ type: "session", directory: "/repo", id: "one" })

    expect(await h.coordinator.requestClose(tab("two"))).toBe(true)
    expect(h.tabs().map((item) => item.id)).toEqual(["one", "three"])

    release()
    expect(await activation).toBe(true)
    expect(h.targets).toEqual([{ type: "session", directory: "/repo", id: "one" }])
    h.dispose()
  })

  test("a newer activation prevents a lifecycle fallback from navigating late", async () => {
    const h = harness({
      tabs: [tab("lifecycle-one"), tab("lifecycle-two")],
      route: { directory: "/repo", id: "lifecycle-one", session: true },
    })
    let release!: () => void
    h.queuePrepare(new Promise<void>((resolve) => (release = resolve)))
    const removal = h.coordinator.remove(tab("lifecycle-one"), "deleted")

    expect(
      await h.coordinator.activate({ type: "session", directory: "/repo", id: "lifecycle-two" }),
    ).toBe(true)
    expect(h.targets).toEqual([{ type: "session", directory: "/repo", id: "lifecycle-two" }])

    release()
    await removal
    expect(h.targets).toEqual([{ type: "session", directory: "/repo", id: "lifecycle-two" }])
    h.dispose()
  })

  test("active close retains the tab until fallback route commits", async () => {
    const h = harness({
      tabs: [tab("one"), tab("two")],
      route: { directory: "/repo", id: "two", session: true },
    })
    expect(await h.coordinator.requestClose(tab("two"))).toBe(true)
    expect(h.tabs().map((item) => item.id)).toEqual(["one", "two"])
    expect(h.targets).toEqual([{ type: "session", directory: "/repo", id: "one" }])

    h.setRoute({ directory: "/repo", id: "one", session: true })
    h.coordinator.observeRoute({ directory: "/repo", id: "one", session: true })
    expect(h.tabs().map((item) => item.id)).toEqual(["one"])
    expect(h.cooled).toEqual([["two"]])
    h.dispose()
  })

  test("close transaction commits after the Solid adapter remounts", async () => {
    const h = harness({
      tabs: [tab("one"), tab("two", "/other")],
      route: { directory: "/other", id: "two", session: true },
    })
    expect(await h.coordinator.requestClose(tab("two", "/other"))).toBe(true)
    h.coordinator.dispose()

    const next = h.remount()
    h.setRoute({ directory: "/repo", id: "one", session: true })
    next.observeRoute({ directory: "/repo", id: "one", session: true })
    expect(h.tabs().map((item) => item.id)).toEqual(["one"])
    expect(h.cooled).toEqual([["two"]])
    next.dispose()
    h.dispose()
  })

  test("a superseded coordinator cannot perform a late navigation", async () => {
    const h = harness({
      tabs: [tab("one"), tab("two", "/other"), tab("three")],
      route: { directory: "/other", id: "two", session: true },
    })
    let release!: () => void
    h.queuePrepare(new Promise<void>((resolve) => (release = resolve)))
    const first = h.coordinator.requestClose(tab("two", "/other"))

    const next = h.remount()
    h.setRoute({ directory: "/repo", id: "three", session: true })
    expect(await next.requestClose(tab("three"))).toBe(true)
    expect(h.targets).toEqual([{ type: "session", directory: "/other", id: "two" }])

    release()
    expect(await first).toBe(false)
    expect(h.targets).toEqual([{ type: "session", directory: "/other", id: "two" }])
    next.dispose()
    h.dispose()
  })

  test("failed fallback preparation aborts close and retains the tab", async () => {
    const h = harness({ tabs: [tab("one")], route: { directory: "/repo", id: "one", session: true } })
    h.setFailPrepare(true)
    expect(await h.coordinator.requestClose(tab("one"))).toBe(false)
    expect(h.tabs().map((item) => item.id)).toEqual(["one"])
    expect(h.targets).toEqual([])
    h.dispose()
  })

  test("a timed out transaction cannot navigate when preparation finishes late", async () => {
    const h = harness({
      tabs: [tab("one")],
      route: { directory: "/repo", id: "one", session: true },
      timeoutMs: 1,
    })
    let release!: () => void
    h.queuePrepare(new Promise<void>((resolve) => (release = resolve)))
    const closing = h.coordinator.requestClose(tab("one"))
    await new Promise((resolve) => setTimeout(resolve, 5))
    release()
    expect(await closing).toBe(false)
    expect(h.targets).toEqual([])
    expect(h.tabs().map((item) => item.id)).toEqual(["one"])
    h.dispose()
  })

  test("non-active close commits immediately without navigation", async () => {
    const h = harness({
      tabs: [tab("one"), tab("two")],
      route: { directory: "/repo", id: "one", session: true },
    })
    expect(await h.coordinator.requestClose(tab("two"))).toBe(true)
    expect(h.tabs().map((item) => item.id)).toEqual(["one"])
    expect(h.targets).toEqual([])
    expect(h.cooled).toEqual([["two"]])
    h.dispose()
  })

  test("confirmed lifecycle removal tombstones an old route", async () => {
    const victim = tab("tombstoned-one")
    const h = harness({ tabs: [victim], route: { directory: "/repo", id: victim.id, session: true } })
    await h.coordinator.remove(victim, "deleted")
    expect(h.tabs()).toEqual([])
    h.coordinator.observeRoute({ directory: "/repo", id: victim.id, session: true })
    expect(h.tabs()).toEqual([])
    h.dispose()
  })

  test("authoritative lifecycle removal supersedes an in-flight user close", async () => {
    const fallback = tab("close-race-one")
    const victim = tab("close-race-two")
    const h = harness({
      tabs: [fallback, victim],
      route: { directory: "/repo", id: victim.id, session: true },
    })
    let release!: () => void
    h.queuePrepare(new Promise<void>((resolve) => (release = resolve)))
    const closing = h.coordinator.requestClose(victim)

    await h.coordinator.remove(victim, "deleted")
    expect(h.tabs().map((item) => item.id)).toEqual([fallback.id])
    expect(h.targets).toEqual([{ type: "session", directory: "/repo", id: fallback.id }])

    release()
    expect(await closing).toBe(false)
    expect(h.targets).toEqual([{ type: "session", directory: "/repo", id: fallback.id }])
    h.dispose()
  })

  test("a duplicate lifecycle remove does not navigate after the owner completes", async () => {
    const victim = tab("duplicate-completed")
    const fallback = tab("duplicate-fallback")
    const h = harness({
      tabs: [fallback, victim],
      route: { directory: "/repo", id: victim.id, session: true },
    })

    await h.coordinator.remove(victim, "archived")
    await h.coordinator.remove(victim, "archived")

    expect(h.tabs().map((item) => item.id)).toEqual([fallback.id])
    expect(h.targets).toEqual([{ type: "session", directory: "/repo", id: fallback.id }])
    h.dispose()
  })

  test("the first lifecycle remove keeps ownership while a duplicate arrives in flight", async () => {
    const victim = tab("duplicate-inflight")
    const fallback = tab("duplicate-inflight-fallback")
    const h = harness({
      tabs: [fallback, victim],
      route: { directory: "/repo", id: victim.id, session: true },
    })
    let release!: () => void
    h.queuePrepare(new Promise<void>((resolve) => (release = resolve)))
    const owner = h.coordinator.remove(victim, "archived")

    await h.coordinator.remove(victim, "archived")
    expect(h.targets).toEqual([])

    release()
    await owner
    expect(h.targets).toEqual([{ type: "session", directory: "/repo", id: fallback.id }])
    h.dispose()
  })

  test("restoring a session revokes its in-flight lifecycle navigation owner", async () => {
    const victim = tab("restore-inflight")
    const fallback = tab("restore-inflight-fallback")
    const h = harness({
      tabs: [fallback, victim],
      route: { directory: "/repo", id: victim.id, session: true },
    })
    let release!: () => void
    h.queuePrepare(new Promise<void>((resolve) => (release = resolve)))
    const removal = h.coordinator.remove(victim, "archived")

    h.coordinator.restore(victim)
    release()
    await removal

    expect(h.targets).toEqual([])
    h.coordinator.ensureOpen(victim)
    expect(h.tabs().map((item) => item.id)).toEqual([fallback.id, victim.id])
    h.dispose()
  })

  test("explicit and event-driven restore notifications are idempotent", async () => {
    const victim = tab("restore-duplicate")
    const h = harness({
      tabs: [victim],
      route: { directory: "/repo", id: victim.id, session: true },
    })

    await h.coordinator.remove(victim, "archived")
    h.coordinator.restore(victim)
    h.coordinator.restore(victim)
    h.coordinator.observeRoute({ directory: "/repo", id: victim.id, session: true })

    expect(h.tabs().map((item) => item.id)).toEqual([victim.id])
    h.dispose()
  })

  test("draft close waits for the target route before removing the draft", async () => {
    const h = harness({
      tabs: [tab("one")],
      drafts: ["/repo"],
      route: { directory: "/repo", session: true },
    })
    expect(await h.coordinator.requestCloseDraft("/repo")).toBe(true)
    expect(h.drafts()).toEqual(["/repo"])
    h.coordinator.observeRoute({ directory: "/repo", id: "one", session: true })
    expect(h.drafts()).toEqual([])
    h.dispose()
  })
})

describe("planSessionTabClose", () => {
  test("closing a parent includes descendants and picks another root", () => {
    const parent = tab("parent")
    const child = tab("child", "/repo", "parent")
    const other = tab("other")
    const plan = planSessionTabClose({
      tabs: [other, parent, child],
      tab: parent,
      route: { directory: "/repo", id: "child", session: true },
      parentID: (value) => value.parentID ?? undefined,
    })
    expect(plan?.closing.map((item) => item.id)).toEqual(["parent", "child"])
    expect(plan?.target).toEqual({ type: "session", directory: "/repo", id: "other" })
  })
})
