import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { GptProJob } from "@opencode-ai/util/gpt-pro"
import { createGptProExecutionStore } from "./gpt-pro-execution-store"
import { createGptProBodyJournal } from "./gpt-pro-body-journal"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

test("legacy SQLite body fallback coalesces streaming updates without rewriting history", () => {
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

test("legacy SQLite body fallback flushes terminal bodies independently of send intent", () => {
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

async function diskFixture() {
  const root = await mkdtemp(join(tmpdir(), "gpt-execution-journal-"))
  const instances: Array<{ close(): Promise<void> }> = []
  let failCommit = false
  return {
    failCommit: (fail: boolean) => {
      failCommit = fail
    },
    open() {
      const db = new Database(join(root, "execution.db"))
      const journal = createGptProBodyJournal(join(root, "bodies"), () => {}, { checkpointMs: 60_000 })
      const store = createGptProExecutionStore(
        {
          exec: (sql) => {
            if (failCommit && sql === "COMMIT") throw Error("critical disk failure")
            return db.exec(sql)
          },
          prepare: (sql) => db.prepare(sql),
          close: () => db.close(),
        },
        () => {},
        60_000,
        journal,
      )
      let closed = false
      const instance = {
        db,
        journal,
        store,
        async close() {
          if (closed) return
          closed = true
          try {
            await store.close()
          } finally {
            await journal.close()
          }
        },
      }
      instances.push(instance)
      return instance
    },
    async dispose() {
      failCommit = false
      try {
        for (const instance of instances) await instance.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}

test("production journal checkpoints only the changed job and restart reads its newest body", async () => {
  const f = await diskFixture()
  try {
    const first = f.open()
    const jobs = Array.from({ length: 32 }, (_, i) => ({ ...job(String(i)), text: "x".repeat(100_000) }))
    first.store.load(() => jobs)
    const before = first.store.metrics()
    for (let i = 1; i <= 60; i++) {
      Object.assign(jobs[0], { text: `Stream ${i}`, html: `<p>${i}</p>`, revision: i, updatedAt: i + 1 })
      first.store.save(jobs)
    }
    expect(first.journal.metrics()).toMatchObject({ writes: 0, pending: 1 })
    expect(first.store.metrics().outboxWrites).toBe(before.outboxWrites)
    expect(first.store.metrics().bodyWrites).toBe(before.bodyWrites)
    expect(first.journal.read("0")).toBeUndefined()
    await first.store.flush()
    expect(first.journal.metrics()).toMatchObject({ writes: 1, pending: 0 })
    expect(first.journal.read("0")).toMatchObject({ text: "Stream 60", revision: 60 })
    await first.close()
    const restored = f.open().store.load(() => {
      throw Error("Legacy history must not be read again")
    })
    expect(restored.find((row) => row.id === "0")).toMatchObject({ text: "Stream 60", html: "<p>60</p>", revision: 60 })
    expect(restored.find((row) => row.id === "31")?.text).toBe(jobs[31].text)
  } finally {
    await f.dispose()
  }
})

test("production send intent is durable before asynchronous answer I/O and never embeds answer HTML", async () => {
  const f = await diskFixture()
  try {
    const { store, db, journal } = f.open()
    const current = { ...job(), phase: "sending" as const, submitted: false, sendAttempted: false }
    store.load(() => [current])
    Object.assign(current, { text: "New streamed body", html: "<p>PRIVATE_BODY</p>", revision: 2, sendAttempted: true })
    store.save([current])
    const row = db.query("SELECT metadata FROM gpt_pro_execution").get() as { metadata: string }
    expect(JSON.parse(row.metadata).sendAttempted).toBe(true)
    expect(row.metadata).not.toMatch(/PRIVATE_BODY|New streamed body/)
    expect(journal.metrics()).toMatchObject({ writes: 0, pending: 1 })
    await store.flush()
    expect(journal.read(current.id)?.text).toBe("New streamed body")
    store.save([{ ...current, phase: "completed" }])
    expect(journal.metrics().writes).toBe(1)
  } finally {
    await f.dispose()
  }
})

test("failed production metadata commit cannot stage an uncommitted body or change send authority", async () => {
  const f = await diskFixture()
  try {
    const { store, db, journal } = f.open()
    const current = { ...job(), submitted: false }
    store.load(() => [current])
    f.failCommit(true)
    expect(() => store.save([{ ...current, text: "Uncommitted body", sendAttempted: true }])).toThrow(
      "critical disk failure",
    )
    expect(journal.metrics()).toMatchObject({ writes: 0, pending: 0 })
    const row = db.query("SELECT metadata FROM gpt_pro_execution").get() as { metadata: string }
    expect(JSON.parse(row.metadata).sendAttempted).toBeUndefined()
    f.failCommit(false)
    await store.flush()
    expect(journal.read(current.id)).toBeUndefined()
  } finally {
    await f.dispose()
  }
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
