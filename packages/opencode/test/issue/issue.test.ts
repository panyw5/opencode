import { expect, test, spyOn } from "bun:test"
import { Effect } from "effect"
import { Issue } from "../../src/issue/issue"
import { IssueTracker } from "../../src/issue/external"
import { Bus } from "../../src/bus"
import { GlobalBus } from "../../src/bus/global"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import * as Database from "../../src/storage/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Bus.defaultLayer)

test("redacts credential-bearing error text", () => {
  const result = Issue.redact(
    'Authorization: Bearer secret-value api_key="private-key" password=private https://user:password@example.test/x',
  )
  expect(result).not.toContain("secret-value")
  expect(result).not.toContain("private-key")
  expect(result).not.toContain("password@example")
})

it.instance("persists local failures without escalating, and preserves original error after recovery", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const first = yield* Issue.report({
      source: "attachment",
      scope: "tool",
      code: "read.failed",
      state: "recorded",
      message: "Cannot read binary file",
      key: "operation-1",
    })
    const duplicate = yield* Issue.report({
      source: "attachment",
      scope: "tool",
      code: "read.failed",
      state: "recorded",
      message: "outer wrapper",
      key: "operation-1",
    })
    expect(first.notify).toBe(false)
    expect(duplicate.issue.id).toBe(first.issue.id)
    expect(Issue.list({ directory })).toHaveLength(1)
    Issue.record(directory, { ...first.issue, state: "resolved", message: "Used another tool successfully" })
    const record = Issue.get(first.issue.id)!
    expect(record.issue.state).toBe("resolved")
    expect(record.history.map((entry) => entry.message)).toContain("Cannot read binary file")
  }),
)

it.instance("notifies once, separates read and acknowledgment from resolution", () =>
  Effect.gen(function* () {
    const first = yield* Issue.report({
      source: "session",
      scope: "session",
      code: "run.failed",
      state: "failed",
      message: "Authentication failed",
      key: "run-1",
    })
    expect(first.notify).toBe(true)
    const read = Issue.mark(first.issue.id, "read")!
    expect(read.readAt).toBeNumber()
    expect(read.acknowledgedAt).toBeUndefined()
    expect(read.state).toBe("failed")
    const ack = Issue.mark(first.issue.id, "acknowledge")!
    expect(ack.acknowledgedAt).toBeNumber()
    expect(ack.state).toBe("failed")
    const repeat = yield* Issue.report({
      source: "session",
      scope: "session",
      code: "run.failed",
      state: "failed",
      message: "wrapped failure",
      key: "run-1",
    })
    expect(repeat.notify).toBe(false)
  }),
)

it.instance("deduplicates retry attempts and retains their history", () =>
  Effect.gen(function* () {
    const input = {
      source: "provider",
      scope: "session" as const,
      code: "provider.retry",
      state: "recovering" as const,
      message: "Rate limited",
      key: "run-2",
    }
    const first = yield* Issue.report({ ...input, occurrenceKey: "1" })
    yield* Issue.report({ ...input, occurrenceKey: "1" })
    yield* Issue.report({ ...input, occurrenceKey: "2" })
    const current = Issue.get(first.issue.id)!
    expect(current.issue.occurrences).toBe(2)
    expect(current.history).toHaveLength(2)
  }),
)

it.instance("deduplicates the same terminal failure across inner and HTTP boundaries", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const first = yield* Issue.fromSessionError({
      sessionID: "ses_boundary",
      error: { name: "UnknownError", data: { message: "Model not found" } },
    })
    const outer = yield* Issue.fromSessionError({
      sessionID: "ses_boundary",
      error: { name: "UnknownError", data: { message: "HTTP wrapper: Model not found" } },
    })
    expect(first.notify).toBe(true)
    expect(outer.notify).toBe(false)
    expect(outer.issue.id).toBe(first.issue.id)
    expect(Issue.list({ directory })).toHaveLength(1)
    expect(Issue.get(first.issue.id)!.issue.message).toBe("Model not found")
  }),
)

it.instance("journals user interaction without issuing a duplicate error notification", () =>
  Effect.gen(function* () {
    const asked = yield* Issue.interaction("permission.asked", {
      id: "request-test",
      sessionID: "ses_permission",
      permission: "bash",
    })
    expect(asked!.issue.state).toBe("needs_user")
    expect(asked!.notify).toBe(false)
    yield* Issue.interaction("permission.replied", { requestID: "request-test", reply: "once" })
    const result = Issue.get(asked!.issue.id)!
    expect(result.issue.state).toBe("resolved")
    expect(result.history).toHaveLength(2)
    expect(result.issue.acknowledgedAt).toBeUndefined()
  }),
)

it.instance("records cancellation and context recovery but does not publish session failures", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const bus = yield* Bus.Service
    const errors: unknown[] = []
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (event: Parameters<typeof GlobalBus.emit>[1]) => {
          if (event.directory === directory && event.payload.type === "session.error") errors.push(event)
        }
        GlobalBus.on("event", listener)
        return listener
      }),
      (listener) =>
        Effect.sync(() => {
          GlobalBus.off("event", listener)
        }),
    )
    const sessionID = SessionID.make("ses_issue_test")
    yield* bus.publish(Session.Event.Error, {
      sessionID,
      error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    })
    yield* bus.publish(Session.Event.Error, {
      sessionID,
      error: { name: "ContextOverflowError", data: { message: "Too large" } },
    })
    expect(errors).toEqual([])
    expect(
      Issue.list({ directory })
        .map((item) => item.state)
        .sort(),
    ).toEqual(["cancelled", "recovering"])
    yield* Issue.settle(sessionID, "resolved", "Compaction succeeded")
    expect(Issue.list({ directory }).some((item) => item.state === "recovering")).toBe(false)
  }),
)

it.instance("replays redacted fallback records after database recovery", () =>
  Effect.gen(function* () {
    const fail = spyOn(Database, "transaction").mockImplementation(() => {
      throw new Error("database unavailable")
    })
    const result = yield* Effect.acquireUseRelease(
      Effect.succeed(fail),
      () =>
        Issue.report({
          source: "storage",
          scope: "application",
          code: "db.failed",
          state: "failed",
          message: "api_key=private",
        }),
      (mock) =>
        Effect.sync(() => {
          mock.mockRestore()
        }),
    )
    expect(result.issue.storage).toBe("fallback")
    const recovered = Issue.get(result.issue.id)!
    expect(recovered.issue.storage).toBe("database")
    expect(recovered.issue.message).not.toContain("private")
  }),
)

for (const domain of ["extra-agent/genericagent", "extra-agent/hermes", "extra-agent/openclaw"]) {
  it.instance(`external bridge ${domain} records failures with original message ownership`, () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const tracker = new IssueTracker(domain)
      tracker.observe({
        directory,
        payload: {
          type: "message.updated",
          properties: { info: { id: "external-message", sessionID: "external-session", role: "assistant" } },
        },
      })
      const event = {
        directory,
        payload: {
          type: "session.error",
          properties: {
            sessionID: "external-session",
            error: { name: "UnknownError", data: { message: "External failure" } },
          } as Record<string, unknown>,
        },
      }
      tracker.observe(event)
      const current = Issue.get(event.payload.properties.issueID as string)!
      expect(current.issue.domain).toBe(domain)
      expect(current.issue.messageID).toBe("external-message")
      expect(current.issue.state).toBe("failed")
    }),
  )
}
