import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGptProBodyJournal } from "./gpt-pro-body-journal"

test("body updates coalesce per job and restart sees only atomically committed content", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-body-journal-"))
  const journal = createGptProBodyJournal(root, () => {}, { checkpointMs: 60_000 })
  try {
    for (let i = 0; i < 60; i++) journal.stage("synthetic", { text: `Answer ${i}`, html: `<p>${i}</p>`, revision: i })
    expect(journal.metrics().writes).toBe(0)
    expect(journal.metrics().pending).toBe(1)
    expect(journal.read("synthetic")).toBeUndefined()
    await journal.flush()
    expect(journal.metrics().writes).toBe(1)
    const restarted = createGptProBodyJournal(root, () => {})
    expect(restarted.read("synthetic")).toEqual({ text: "Answer 59", html: "<p>59</p>", revision: 59 })
    await restarted.close()
  } finally {
    await journal.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("new content during an async commit cannot be dropped or replaced by an older snapshot", async () => {
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const versions: number[] = []
  const journal = createGptProBodyJournal("/unused", () => {}, {
    checkpointMs: 60_000,
    commit: async (_id, body) => {
      versions.push(body.revision)
      if (body.revision === 1) {
        entered()
        await gate
      }
    },
  })
  journal.stage("synthetic", { revision: 1, text: "old" })
  const writing = journal.flush()
  await ready
  journal.stage("synthetic", { revision: 2, text: "new" })
  release()
  await writing
  expect(versions).toEqual([1])
  expect(journal.metrics().pending).toBe(1)
  await journal.flush()
  expect(versions).toEqual([1, 2])
  expect(journal.metrics().pending).toBe(0)
  await journal.close()
})
test("a flush is a finite version barrier even when another answer keeps changing", async () => {
  let changing = true
  const versions: string[] = []
  const journal = createGptProBodyJournal("/unused", () => {}, {
    checkpointMs: 60_000,
    commit: async (id, body) => {
      versions.push(`${id}:${body.revision}`)
      if (id === "stream" && changing) journal.stage(id, { revision: body.revision + 1, text: "next" })
    },
  })
  journal.stage("final", { revision: 1, text: "final" })
  journal.stage("stream", { revision: 1, text: "partial" })
  await journal.flush()
  expect(versions).toEqual(["final:1", "stream:1"])
  expect(journal.metrics().pending).toBe(1)
  changing = false
  await journal.close()
})

test("a failed checkpoint retains pending content and permits explicit storage recovery", async () => {
  let fail = true
  const journal = createGptProBodyJournal("/unused", () => {}, {
    checkpointMs: 60_000,
    commit: async () => {
      if (fail) throw Error("disk unavailable")
    },
  })
  journal.stage("synthetic", { revision: 1, text: "not lost" })
  await expect(journal.flush()).rejects.toThrow("result_storage")
  expect(journal.metrics().pending).toBe(1)
  fail = false
  await journal.flush()
  expect(journal.metrics().pending).toBe(0)
  await journal.close()
})
