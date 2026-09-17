import { describe, expect, test } from "bun:test"
import { imLoadBatch, imPreferenceInitPending, imSelectedProject } from "./config-im"
import { parseRetentionDays, rebaseChannelMap } from "./config-channel-helpers"

describe("channel IM service configuration", () => {
  test("restores the saved project instead of resetting to the current workspace", () => {
    expect(imSelectedProject("/saved", "/current", ["/saved", "/current"])).toBe("/saved")
  })
  test("never operates on a missing or internal project", () => {
    expect(imSelectedProject("/closed", "/current", ["/current"])).toBe("/current")
    expect(imSelectedProject("/closed", "/internal", ["/other"])).toBe("")
    expect(imSelectedProject("/saved", "/current", [])).toBe("")
  })
  test("loads channels and watches with one bounded three-request batch", async () => {
    const calls: string[] = []
    const result = await imLoadBatch({
      channels: async () => {
        calls.push("channels")
        return "channels"
      },
      subscriptions: async () => {
        calls.push("subscriptions")
        return "subscriptions"
      },
      sessions: async () => {
        calls.push("sessions")
        return "sessions"
      },
    })
    expect(calls).toEqual(["channels", "subscriptions", "sessions"])
    expect(result).toEqual(["channels", "subscriptions", "sessions"])
  })

  test("keeps asynchronous preference initialization local to the IM pane", () => {
    expect(imPreferenceInitPending(Promise.resolve(null))).toBe(true)
    expect(imPreferenceInitPending(null)).toBe(false)
  })

  test("accepts only bounded optional retention periods", () => {
    expect(parseRetentionDays("")).toBeUndefined()
    expect(parseRetentionDays("1")).toBe(1)
    expect(parseRetentionDays("3650")).toBe(3650)
    expect(parseRetentionDays("0")).toBeUndefined()
    expect(parseRetentionDays("3651")).toBeUndefined()
    expect(parseRetentionDays("1.5")).toBeUndefined()
  })

  test("rebases rapid channel edits without losing completed fields", () => {
    const base = { bot: { autoReply: true, retentionDays: 7, enabled: true } }
    const retentionEdit = { bot: { autoReply: true, retentionDays: 14, enabled: true } }
    const toggleEdit = { bot: { autoReply: false, retentionDays: 7, enabled: true } }
    const afterRetention = rebaseChannelMap(base, retentionEdit, base)
    const afterToggle = rebaseChannelMap(base, toggleEdit, afterRetention)
    expect(afterToggle).toEqual({ bot: { autoReply: false, retentionDays: 14, enabled: true } })
    const independentToggle = rebaseChannelMap(base, { bot: { autoReply: false, retentionDays: 7, enabled: true } }, afterRetention)
    expect(independentToggle.bot).toEqual({ autoReply: false, retentionDays: 14, enabled: true })
  })
})
