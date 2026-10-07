import { describe, expect, test } from "bun:test"
import { createExtensionMutationTracker } from "./mutation"

describe("extension mutation tracker", () => {
  test("marks an id busy until released", () => {
    const tracker = createExtensionMutationTracker()
    expect(tracker.busy("ext.a")).toBe(false)
    expect(tracker.ids()).toEqual(new Set())
    const release = tracker.begin({ serverURL: "http://a:1", id: "ext.a" })
    expect(tracker.busy("ext.a")).toBe(true)
    expect(tracker.ids()).toEqual(new Set(["ext.a"]))
    release()
    expect(tracker.busy("ext.a")).toBe(false)
    expect(tracker.ids()).toEqual(new Set())
  })

  test("rejects a second begin for the same id on the same server", () => {
    const tracker = createExtensionMutationTracker()
    const release = tracker.begin({ serverURL: "http://a:1", id: "ext.a" })
    expect(() => tracker.begin({ serverURL: "http://a:1", id: "ext.a" })).toThrow("already in progress")
    release()
    const next = tracker.begin({ serverURL: "http://a:1", id: "ext.a" })
    expect(tracker.busy("ext.a")).toBe(true)
    next()
    expect(tracker.busy("ext.a")).toBe(false)
  })

  test("does not block the same id against a different server", () => {
    const tracker = createExtensionMutationTracker()
    const releaseA = tracker.begin({ serverURL: "http://a:1", id: "ext.a" })
    const releaseB = tracker.begin({ serverURL: "http://b:1", id: "ext.a" })
    expect(tracker.busy("ext.a")).toBe(true)
    releaseA()
    expect(tracker.busy("ext.a")).toBe(true)
    releaseB()
    expect(tracker.busy("ext.a")).toBe(false)
  })

  test("release is idempotent", () => {
    const tracker = createExtensionMutationTracker()
    const release = tracker.begin({ serverURL: "http://a:1", id: "ext.a" })
    release()
    expect(() => release()).not.toThrow()
    expect(tracker.busy("ext.a")).toBe(false)
  })

  test("releaseServer drops only the abandoned server's locks", () => {
    const tracker = createExtensionMutationTracker()
    const releaseA = tracker.begin({ serverURL: "http://a:1", id: "ext.a" })
    tracker.begin({ serverURL: "http://b:1", id: "ext.a" })
    tracker.begin({ serverURL: "http://a:1", id: "ext.b" })
    tracker.releaseServer("http://a:1")
    // ext.a is still busy via server b; ext.b was freed with the old server.
    expect(tracker.busy("ext.a")).toBe(true)
    expect(tracker.busy("ext.b")).toBe(false)
    // The abandoned release cannot free the other server's lock.
    releaseA()
    expect(tracker.busy("ext.a")).toBe(true)
    tracker.releaseServer("http://b:1")
    expect(tracker.ids()).toEqual(new Set())
  })

  test("an abandoned release does not remove a newer lock at the same server", () => {
    const tracker = createExtensionMutationTracker()
    const old = tracker.begin({ serverURL: "http://a:1", id: "ext.a" })
    tracker.releaseServer("http://a:1")
    const fresh = tracker.begin({ serverURL: "http://a:1", id: "ext.a" })
    old()
    expect(tracker.busy("ext.a")).toBe(true)
    expect(() => tracker.begin({ serverURL: "http://a:1", id: "ext.a" })).toThrow("already in progress")
    fresh()
    expect(tracker.busy("ext.a")).toBe(false)
  })

  test("tracks independent ids separately", () => {
    const tracker = createExtensionMutationTracker()
    const releaseA = tracker.begin({ serverURL: "http://a:1", id: "ext.a" })
    tracker.begin({ serverURL: "http://a:1", id: "ext.b" })
    expect(tracker.busy("ext.a")).toBe(true)
    expect(tracker.busy("ext.b")).toBe(true)
    releaseA()
    expect(tracker.busy("ext.a")).toBe(false)
    expect(tracker.busy("ext.b")).toBe(true)
  })
})
