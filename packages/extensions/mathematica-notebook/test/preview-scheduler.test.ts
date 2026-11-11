import { expect, test } from "bun:test"
import { createPreviewScheduler } from "../src/preview-scheduler"
import type { CellsResponse, Preview } from "../src/preview-protocol"

function harness() {
  let id = 0
  const frames = new Map<number, FrameRequestCallback>()
  const requests: {
    indexes: number[]
    signal: AbortSignal
    resolve(value: CellsResponse): void
    reject(error: Error): void
  }[] = []
  const scheduler = createPreviewScheduler(
    (revision, indexes, signal) =>
      new Promise((resolve, reject) => requests.push({ indexes, signal, resolve, reject })),
    () => {},
    {
      request: (callback) => {
        frames.set(++id, callback)
        return id
      },
      cancel: (key) => {
        frames.delete(key)
      },
    },
  )
  const tick = async () => {
    const current = [...frames.values()]
    frames.clear()
    for (const callback of current) callback(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  const reply = (request: (typeof requests)[number], indexes = request.indexes, revision = "a") =>
    request.resolve({
      revision,
      cells: indexes.map((index) => ({
        index,
        preview: { index, status: "complete", box: { kind: "text", text: `${index}` }, reasons: [], nodes: 1 },
      })),
    })
  scheduler.reset("a")
  return { scheduler, requests, tick, reply }
}

test("scheduler batches eight cells, limits concurrency and coalesces subscribers", async () => {
  const h = harness()
  const received: (Preview | Error)[] = []
  for (let i = 0; i < 25; i++) h.scheduler.request(i, (value) => received.push(value))
  h.scheduler.request(0, (value) => received.push(value))
  await h.tick()
  expect(h.requests.map((r) => r.indexes.length)).toEqual([8, 8])
  h.reply(h.requests[0])
  await h.tick()
  await h.tick()
  expect(h.requests).toHaveLength(3)
  expect(received).toHaveLength(9)
  h.scheduler.dispose()
})

test("unsubscribed queued cells and stale revisions never commit", async () => {
  const h = harness()
  let received = 0
  const off = h.scheduler.request(0, () => received++)
  off()
  await h.tick()
  expect(h.requests).toHaveLength(0)
  h.scheduler.request(1, () => received++)
  await h.tick()
  h.scheduler.reset("b")
  expect(h.requests[0].signal.aborted).toBe(true)
  h.reply(h.requests[0])
  await h.tick()
  expect(received).toBe(0)
  h.scheduler.dispose()
})

test("cancelled in-flight batches do not swallow a new subscription for the same cell", async () => {
  const h = harness()
  let received = 0
  const off = h.scheduler.request(1, () => received++)
  await h.tick()
  off()
  expect(h.requests[0].signal.aborted).toBe(true)
  h.scheduler.request(1, () => received++)
  h.requests[0].reject(Error("aborted"))
  await h.tick()
  await h.tick()
  expect(h.requests).toHaveLength(2)
  h.reply(h.requests[1])
  await h.tick()
  await h.tick()
  expect(received).toBe(1)
  h.scheduler.dispose()
})

test("byte-limited responses requeue missing cells; remounts hit the data cache", async () => {
  const h = harness()
  let received = 0
  for (let i = 0; i < 3; i++) h.scheduler.request(i, () => received++)
  await h.tick()
  h.reply(h.requests[0], [0])
  await h.tick()
  await h.tick()
  expect(h.requests[1].indexes).toEqual([1, 2])
  h.scheduler.request(0, () => received++)
  expect(received).toBe(2)
  h.scheduler.dispose()
})
