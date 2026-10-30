import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { GptProJob } from "@opencode-ai/util/gpt-pro"
import { createGptProExecutionStore } from "./gpt-pro-execution-store"

const job = (id = "synthetic"): GptProJob => ({
  id,
  owner: "test",
  requestID: id,
  prompt: "managed",
  phase: "generating",
  url: "https://chatgpt.com/",
  createdAt: 1,
  updatedAt: 1,
  revision: 0,
  submitted: true,
  text: "old",
  html: "<p>old</p>",
})

test("one streaming consultation never rewrites other consultation bodies", () => {
  const db = new Database(":memory:")
  const store = createGptProExecutionStore(db, () => {}, 60_000)
  const jobs = Array.from({ length: 32 }, (_, i) => ({
    ...job(String(i)),
    text: "x".repeat(100_000),
    html: "y".repeat(200_000),
  }))
  store.load(() => jobs)
  const before = store.metrics()
  for (let i = 0; i < 60; i++) {
    jobs[0].text += "a"
    jobs[0].revision++
    jobs[0].updatedAt++
    store.save(jobs)
  }
  const metrics = store.metrics()
  expect(metrics.bodyWrites - before.bodyWrites).toBe(0)
  expect(metrics.metadataWrites - before.metadataWrites).toBe(60)
  expect(metrics.serializedBytes - before.serializedBytes).toBeLessThan(30_000)
  store.flush()
  expect(store.metrics().bodyWrites - before.bodyWrites).toBe(1)
  expect(
    store.load(() => {
      throw Error("legacy read twice")
    })[0].text,
  ).toBe(jobs[0].text)
  store.close()
})

test("send intent commits independently of pending body checkpoints and terminal state forces flush", () => {
  const db = new Database(":memory:")
  const store = createGptProExecutionStore(db, () => {}, 60_000)
  const current = { ...job(), submitted: false, phase: "sending" as const }
  store.load(() => [current])
  current.text = "new streamed body"
  current.sendAttempted = true
  store.save([current])
  expect(
    JSON.parse((db.query("SELECT metadata FROM gpt_pro_execution").get() as { metadata: string }).metadata)
      .sendAttempted,
  ).toBe(true)
  expect(store.load(() => [])[0].text).toBe("old")
  store.save([{ ...current, phase: "completed" }])
  expect(store.metrics().pendingBodies).toBe(0)
  expect(store.load(() => [])[0].text).toBe("new streamed body")
  store.close()
})

test("migration is once-only and legacy source stays untouched", () => {
  const db = new Database(":memory:")
  const store = createGptProExecutionStore(db, () => {})
  let reads = 0
  const source = [job()]
  store.load(() => {
    reads++
    return source
  })
  store.load(() => {
    reads++
    return []
  })
  expect(reads).toBe(1)
  expect(source[0].text).toBe("old")
  store.close()
})

test("failed critical commit rolls back and does not authorize a send", () => {
  const db = new Database(":memory:")
  let fail = false
  const store = createGptProExecutionStore(
    {
      exec: (sql) => {
        if (fail && sql === "COMMIT") throw Error("disk failure")
        return db.exec(sql)
      },
      prepare: (sql) => db.prepare(sql),
      close: () => db.close(),
    },
    () => {},
  )
  const current = { ...job(), submitted: false }
  store.load(() => [current])
  fail = true
  expect(() => store.save([{ ...current, sendAttempted: true }])).toThrow("disk failure")
  fail = false
  expect(store.load(() => [])[0].sendAttempted).toBeUndefined()
  store.close()
})
