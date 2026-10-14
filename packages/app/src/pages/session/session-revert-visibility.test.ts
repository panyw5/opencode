import { describe, expect, test } from "bun:test"
import { resolveSessionRevertBoundary, visibleBeforeRevert } from "./session-revert-visibility"

const message = (id: string, created: number) => ({ id, time: { created } })

describe("revert send visibility", () => {
  test("never treats the rollback target itself as a new pending send", () => {
    const reverted = message("msg_boundary", 200)
    const pending = message("msg_new", 300)
    const boundary = resolveSessionRevertBoundary({
      sessionKey: "session",
      messageID: reverted.id,
      messages: [reverted],
    })
    expect(visibleBeforeRevert([reverted, pending], boundary, () => true)).toEqual([pending])
  })

  test("shows a pending send immediately without restoring the reverted suffix", () => {
    const retained = message("msg_z_old", 100)
    const reverted = message("msg_boundary", 200)
    const suffix = message("msg_a_hidden", 300)
    const pending = message("msg_a_new", 400)
    const boundary = resolveSessionRevertBoundary({
      sessionKey: "session",
      messageID: reverted.id,
      messages: [reverted],
    })
    const all = [retained, reverted, suffix, pending]
    expect(visibleBeforeRevert(all, boundary, (id) => id === pending.id)).toEqual([retained, pending])
    expect(visibleBeforeRevert(all.slice(0, -1), boundary)).toEqual([retained])
    expect(visibleBeforeRevert(all, undefined)).toBe(all)
  })

  test("keeps chronological visibility stable while cleanup deletes the boundary", () => {
    const retained = message("msg_z_old", 100)
    const reverted = message("msg_boundary", 200)
    const suffix = message("msg_a_hidden", 300)
    const pending = message("msg_a_new", 400)
    const previous = resolveSessionRevertBoundary({
      sessionKey: "session",
      messageID: reverted.id,
      messages: [reverted],
    })
    const boundary = resolveSessionRevertBoundary({
      sessionKey: "session",
      messageID: reverted.id,
      messages: [],
      previous,
    })
    expect(boundary).toBe(previous)
    expect(visibleBeforeRevert([retained, suffix, pending], boundary, (id) => id === pending.id)).toEqual([
      retained,
      pending,
    ])
  })

  test("resolves unloaded boundaries from the user-message index", () => {
    const reverted = message("msg_boundary", 200)
    const boundary = resolveSessionRevertBoundary({
      sessionKey: "session",
      messageID: reverted.id,
      messages: [],
      indexed: [reverted],
    })
    expect(visibleBeforeRevert([message("msg_z_old", 100), message("msg_a_hidden", 300)], boundary)).toEqual([
      message("msg_z_old", 100),
    ])
  })

  test("snapshots the boundary timestamp instead of retaining a deleted store proxy", () => {
    const reverted = message("msg_boundary", 200)
    const previous = resolveSessionRevertBoundary({
      sessionKey: "session",
      messageID: reverted.id,
      messages: [reverted],
    })
    reverted.time.created = 0
    const boundary = resolveSessionRevertBoundary({
      sessionKey: "session",
      messageID: reverted.id,
      messages: [],
      previous,
    })
    expect(boundary?.message.time?.created).toBe(200)
    expect(visibleBeforeRevert([message("msg_old", 100), message("msg_inbox_synthetic", 300)], boundary)).toEqual([
      message("msg_old", 100),
    ])
  })

  test("does not retain boundaries across sessions, restore, or another revert", () => {
    const previous = resolveSessionRevertBoundary({
      sessionKey: "session",
      messageID: "msg_boundary",
      messages: [message("msg_boundary", 200)],
    })
    expect(
      resolveSessionRevertBoundary({ sessionKey: "other", messageID: "msg_boundary", messages: [], previous })?.message
        .time,
    ).toBeUndefined()
    expect(resolveSessionRevertBoundary({ sessionKey: "session", messages: [], previous })).toBeUndefined()
    expect(
      resolveSessionRevertBoundary({ sessionKey: "session", messageID: "msg_other", messages: [], previous })?.message
        .time,
    ).toBeUndefined()
  })
})
