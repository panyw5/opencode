import { describe, expect, test } from "bun:test"
import type { GptProJob } from "@opencode-ai/util/gpt-pro"
import type { GptProStateEvent } from "@opencode-ai/util/gpt-pro-state"
import { GptProStateFeed } from "./gpt-pro-state-feed"

const job = (): GptProJob => ({
  id: "one",
  owner: "/repo\nsession",
  requestID: "one",
  prompt: "private prompt",
  phase: "paused",
  url: "https://chatgpt.com/c/one",
  createdAt: 1,
  updatedAt: 1,
  submitted: false,
  revision: 0,
})

describe("durable GPT-Pro state feed", () => {
  test("versions field clears even when the clock and answer revision do not change", () => {
    const feed = new GptProStateFeed(() => {})
    const current = { ...job(), recovery: { stage: "ready" as const, reason: "old" }, stopPending: true }
    const first = feed.commit([current], () => {})!
    Object.assign(current, { recovery: undefined, stopPending: false })
    const next = feed.commit([current], () => {})!
    expect(next.jobs[0]).toMatchObject({ recovery: null, stopPending: false, stateVersion: 2 })
    expect(next.sequence).toBe(first.sequence + 1)
    expect(current.revision).toBe(0)
    expect(feed.commit([current], () => {})).toBeUndefined()
  })
  test("failed persistence neither advances the durable version nor publishes state", () => {
    const feed = new GptProStateFeed(() => {})
    const current = job()
    feed.publish(feed.commit([current], () => {}))
    const events: GptProStateEvent[] = []
    feed.subscribe((event) => events.push(event))
    current.phase = "completed"
    expect(() =>
      feed.commit([current], () => {
        throw Error("disk full")
      }),
    ).toThrow()
    expect(feed.list()).toMatchObject({ sequence: 1, jobs: [{ phase: "paused", stateVersion: 1 }] })
    expect(current.stateVersion).toBe(1)
    expect(events).toEqual([])
  })
  test("snapshots, removals, source identity, and subscriber cleanup are explicit", () => {
    const feed = new GptProStateFeed(() => {})
    const events: GptProStateEvent[] = []
    const off = feed.subscribe((event) => events.push(event))
    feed.publish(feed.commit([job()], () => {}))
    expect(feed.list()).toMatchObject({ type: "snapshot", sequence: 1 })
    const removal = feed.commit([], () => {})!
    expect(removal.removed).toEqual(["one"])
    off()
    feed.publish(removal)
    expect(events).toHaveLength(1)
    expect(new GptProStateFeed(() => {}).sourceID).not.toBe(feed.sourceID)
  })
  test("durable versions survive a controller restart", () => {
    const first = new GptProStateFeed(() => {})
    const current = job()
    first.commit([current], () => {})
    const next = new GptProStateFeed(() => {})
    next.commit([structuredClone(current)], () => {})
    expect(next.list().jobs[0].stateVersion).toBe(2)
  })
})
