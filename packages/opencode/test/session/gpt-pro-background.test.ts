import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { BackgroundGptPro, notificationText } from "../../src/background/gpt-pro"
import { Browser } from "../../src/browser"
import { Session } from "../../src/session/session"
import { SessionInput } from "../../src/session/input"
import { InstanceState } from "../../src/effect/instance-state"
import { testEffect, pollWithTimeout } from "../lib/effect"
import type { GptProNotification } from "@opencode-ai/util/gpt-pro"
import type { SessionID } from "../../src/session/schema"

const events: Record<string, GptProNotification[]> = {}
const acknowledgements: Record<string, string[][]> = {}
const browser = Layer.mock(Browser.Service, {
  gptProNotifications: (directory) => Effect.succeed(events[directory] ?? []),
  gptProAcknowledge: (directory, ids) =>
    Effect.sync(() => {
      ;(acknowledgements[directory] ??= []).push(ids)
    }),
})
const it = testEffect(
  BackgroundGptPro.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(browser, Session.defaultLayer, SessionInput.defaultLayer)),
  ),
)

describe("background Pro inbox delivery", () => {
  it.instance("a blocked model drain cannot prevent the next completion from reaching the durable inbox", () =>
    Effect.gen(function* () {
      const service = yield* BackgroundGptPro.Service
      const sessions = yield* Session.Service
      const inbox = yield* SessionInput.Service
      const { directory } = yield* InstanceState.context
      const parent = yield* sessions.create({ title: "Blocked drain" })
      const gate = yield* Deferred.make<void>()
      service.registerDrain(() => Deferred.await(gate))
      const event: GptProNotification = {
        id: "gpt_blocked:notification:1",
        consultationID: "gpt_blocked",
        owner: `${directory}\n${parent.id}`,
        phase: "generating",
        revision: 1,
        at: 1,
        url: "https://chatgpt.com/c/test",
        kind: "progress",
        format: "snapshot",
        text: "Partial",
        truncated: false,
      }
      acknowledgements[directory] = []
      events[directory] = [event]
      yield* service.poll().pipe(Effect.timeout("1 second"))
      events[directory] = [
        { ...event, id: "gpt_blocked:notification:2", phase: "completed", kind: "completed", text: "Final" },
      ]
      yield* service.poll().pipe(Effect.timeout("1 second"))
      expect((yield* inbox.pending(parent.id)).map((row) => row.prompt.metadata?.phase)).toEqual([
        "generating",
        "completed",
      ])
      expect(acknowledgements[directory]).toHaveLength(2)
      yield* Deferred.succeed(gate, undefined)
    }),
  )
  it.instance("recovery notifications tell the parent to reuse scoped browser tools instead of resubmitting", () =>
    Effect.gen(function* () {
      const text = notificationText({
        id: "gpt_recover:notification:1",
        consultationID: "gpt_recover",
        owner: "/repo\nses_parent",
        phase: "paused",
        revision: 0,
        at: 1,
        url: "https://chatgpt.com/",
        kind: "state",
        format: "snapshot",
        text: "",
        truncated: false,
        recovery: { stage: "compose", reason: "Unknown overlay" },
      })
      expect(text).toContain("FIXED FLOW NEEDS AGENT RECOVERY")
      expect(text).toContain("consultation_id=gpt_recover")
      expect(text).toContain("browser_read/browser_screenshot/browser_click")
      expect(text).toContain("action=resume")
      expect(text).toContain("Do not create a new consultation or resend")
    }),
  )
  it.instance("login recovery notifications do not mislabel login as an automated browser challenge", () =>
    Effect.gen(function* () {
      const text = notificationText({ id: "gpt_login:notification:1", consultationID: "gpt_login", owner: "/repo\nses_parent", phase: "paused", revision: 0, at: 1, url: "https://chatgpt.com/", kind: "state", format: "snapshot", text: "", truncated: false,
        errorCode: "login_expired", recovery: { stage: "submit", reason: "Login cannot refresh", humanAction: "login" } })
      expect(text).toContain("human recovery required")
      expect(text).toContain("HUMAN LOGIN REQUIRED")
      expect(text).not.toContain("HUMAN BROWSER VERIFICATION")
      expect(text).not.toContain("FIXED FLOW NEEDS AGENT RECOVERY")
      expect(text).toContain("Do not create a new consultation or resend")
    }),
  )
  it.instance("durably admits notifications before acknowledgement and deduplicates replay", () =>
    Effect.gen(function* () {
      const service = yield* BackgroundGptPro.Service
      const sessions = yield* Session.Service
      const inbox = yield* SessionInput.Service
      const { directory } = yield* InstanceState.context
      const parent = yield* sessions.create({ title: "Pro background test" })
      const consultationID = `gpt_${parent.id}`
      const drained: SessionID[] = []
      service.registerDrain((id) =>
        Effect.sync(() => {
          drained.push(id)
        }),
      )
      acknowledgements[directory] = []
      events[directory] = [
        {
          id: `${consultationID}:notification:1`,
          consultationID,
          owner: `${directory}\n${parent.id}`,
          phase: "generating",
          revision: 1,
          at: 1,
          url: "https://chatgpt.com/c/test",
          kind: "progress",
          format: "snapshot",
          text: "Partial answer",
          truncated: false,
        },
      ]
      yield* service.poll()
      yield* pollWithTimeout(
        Effect.sync(() => (drained.length ? true : undefined)),
        "parent was not scheduled",
      )
      expect(acknowledgements[directory]).toEqual([[events[directory][0].id]])
      const rows = yield* inbox.pending(parent.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].prompt.metadata?.notificationType).toBe("progress")
      expect(rows[0].prompt.text).toContain("NOT final")
      yield* service.poll()
      expect(yield* inbox.pending(parent.id)).toHaveLength(1)
      yield* pollWithTimeout(
        Effect.sync(() => (drained.length >= 2 ? true : undefined)),
        "replayed pending input was not scheduled",
      )
      yield* service.suppress(parent.id, true)
      expect(yield* service.suppressed(parent.id)).toBe(true)
      const count = drained.length
      events[directory] = [
        {
          ...events[directory][0],
          id: `${consultationID}:notification:2`,
          phase: "completed",
          kind: "completed",
          text: "Final answer",
        },
      ]
      yield* service.poll()
      expect(yield* inbox.pending(parent.id)).toHaveLength(2)
      expect(drained.length).toBe(count)
      yield* service.suppress(parent.id, false, false)
      expect(drained.length).toBe(count)
      yield* service.suppress(parent.id, false)
      events[directory] = []
      yield* service.poll()
      yield* pollWithTimeout(
        Effect.sync(() => (drained.length > count ? true : undefined)),
        "retained completion was not scheduled",
      )
    }),
  )
  it.instance("rejects another directory's event and does not wake an archived session", () =>
    Effect.gen(function* () {
      const service = yield* BackgroundGptPro.Service
      const sessions = yield* Session.Service
      const inbox = yield* SessionInput.Service
      const { directory } = yield* InstanceState.context
      const parent = yield* sessions.create({ title: "Archived Pro test", archived: true })
      const consultationID = `gpt_${parent.id}`
      const drained: SessionID[] = []
      service.registerDrain((id) =>
        Effect.sync(() => {
          drained.push(id)
        }),
      )
      acknowledgements[directory] = []
      events[directory] = [
        {
          id: `${consultationID}:notification:foreign`,
          consultationID,
          owner: `/other\n${parent.id}`,
          phase: "completed",
          revision: 1,
          at: 1,
          url: "https://chatgpt.com/c/test",
          kind: "completed",
          format: "snapshot",
          text: "Final",
          truncated: false,
        },
      ]
      yield* service.poll()
      expect(yield* inbox.pending(parent.id)).toHaveLength(0)
      expect(acknowledgements[directory]).toHaveLength(0)
      events[directory] = [
        {
          ...events[directory][0],
          id: `${consultationID}:notification:2`,
          owner: directory + String.fromCharCode(10) + parent.id,
        },
      ]
      expect(yield* service.receive(events[directory][0])).toMatchObject({ ack: true })
      expect(yield* inbox.pending(parent.id)).toHaveLength(1)
      yield* service.poll()
      expect(yield* inbox.pending(parent.id)).toHaveLength(1)
      expect(drained).toHaveLength(0)
      expect(notificationText({ ...events[directory][0], truncated: true })).toContain("action=read")
    }),
  )
})
