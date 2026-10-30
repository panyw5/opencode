// Synthetic, credential-free baseline. Never opens a browser or consults the user's sessions.
import { GPT_PRO_PARTITION, GPT_PRO_URL, type GptProJob } from "@opencode-ai/util/gpt-pro"
import { GptProProbe } from "../src/main/gpt-pro-probe"
import { createGptProPersistence } from "../src/main/gpt-pro-persistence"
import { createGptProExecutionStore } from "../src/main/gpt-pro-execution-store"
import { createGptProBodyJournal } from "../src/main/gpt-pro-body-journal"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let requests = 0
let inspections = 0
const views = ["valid", "login"].map((pageID) => ({
  pageID,
  partition: pageID,
  profileID: GPT_PRO_PARTITION,
  epoch: 1,
  url: pageID === "valid" ? GPT_PRO_URL : `${GPT_PRO_URL}auth/login`,
  title: "Synthetic",
  loading: false,
  shared: false,
}))
const browser = {
  has: () => true,
  open: async () => views[0],
  present: () => {},
  getState: () => views,
  cdp: () => ({
    evaluate: async <T>(expression: string) => {
      if (expression.includes("/api/auth/session")) {
        requests++
        return { phase: "authenticated", identity: "synthetic-baseline" } as T
      }
      inspections++
      return { url: GPT_PRO_URL, composer: false, model: "", users: [], revision: 0 } as T
    },
  }),
}
const probe = new GptProProbe(browser)
const forward = (await probe.authentication()).phase
views.reverse()
const reverse = (await probe.authentication()).phase

const jobs: GptProJob[] = Array.from({ length: 32 }, (_, index) => ({
  id: `synthetic-${index}`,
  owner: "synthetic",
  requestID: `request-${index}`,
  phase: "completed",
  prompt: "synthetic",
  url: GPT_PRO_URL,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  submitted: true,
  background: true,
  text: "x".repeat(100_000),
  html: "y".repeat(200_000),
}))
let bytes = 0
let writes = 0
let raw = ""
const persistence = createGptProPersistence(
  {
    get: () => undefined,
    set: (_key, value) => {
      raw = JSON.stringify(value)
      bytes += Buffer.byteLength(raw)
      writes++
    },
  },
  () => {},
)
const durations: number[] = []
jobs[0].phase = "generating"
for (let i = 0; i < 60; i++) {
  jobs[0].text += "a"
  jobs[0].revision++
  const start = performance.now()
  persistence.save(jobs)
  durations.push(performance.now() - start)
}
durations.sort((a, b) => a - b)
const root = await mkdtemp(join(tmpdir(), "gpt-pro-baseline-"))
const bodies = createGptProBodyJournal(join(root, "bodies"), () => {}, { checkpointMs: 60_000 })
const execution = createGptProExecutionStore(new Database(join(root, "execution.db")), () => {}, 60_000, bodies)
execution.load(() => jobs)
const startMetrics = execution.metrics()
const nextDurations: number[] = []
for (let i = 0; i < 60; i++) {
  jobs[0].text += "a"
  jobs[0].revision++
  jobs[0].updatedAt++
  const start = performance.now()
  execution.save(jobs)
  nextDurations.push(performance.now() - start)
}
const preFlush = execution.metrics()
const bodyBeforeFlush = bodies.metrics()
const flushStart = performance.now()
await execution.flush()
const flushMs = performance.now() - flushStart
const finalMetrics = execution.metrics()
const bodyAfterFlush = bodies.metrics()
nextDurations.sort((a, b) => a - b)
await execution.close()
await bodies.close()
await rm(root, { recursive: true, force: true })
console.info(
  JSON.stringify(
    {
      synthetic: true,
      authentication: { forward, reverse, requests, inspections },
      persistence: {
        jobs: jobs.length,
        updates: durations.length,
        writes,
        serializedBytes: bytes,
        p50Ms: durations[30],
        p95Ms: durations[57],
        p99Ms: durations[59],
        lastBytes: raw.length,
      },
      executionStore: {
        bodyStorage: "async_per_job_journal",
        metadataWrites: preFlush.metadataWrites - startMetrics.metadataWrites,
        bodyWritesBeforeFlush: bodyBeforeFlush.writes,
        bodyWritesAfterFlush: bodyAfterFlush.writes,
        bytesBeforeFlush: preFlush.serializedBytes - startMetrics.serializedBytes,
        bytesAfterFlush: finalMetrics.serializedBytes - startMetrics.serializedBytes + bodyAfterFlush.serializedBytes,
        p95Ms: nextDurations[57],
        p99Ms: nextDurations[59],
        flushMs,
      },
    },
    null,
    2,
  ),
)
