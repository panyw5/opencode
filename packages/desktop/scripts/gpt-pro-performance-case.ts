import { performance, monitorEventLoopDelay } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import Store from "electron-store"
import type { BrowserController } from "../src/main/browser"
import { createGptProExecutionStore } from "../src/main/gpt-pro-execution-store"
import { createGptProBodyJournal } from "../src/main/gpt-pro-body-journal"
import { chatGptCaptureExpression } from "@opencode-ai/util/chatgpt-page"
import { GPT_PRO_URL, type GptProJob, type GptProPageState } from "@opencode-ai/util/gpt-pro"

const stats = (values: number[]) => {
  const a = values.slice().sort((x, y) => x - y)
  return {
    samples: a.length,
    p50Ms: a[Math.floor(a.length * 0.5)],
    p95Ms: a[Math.floor(a.length * 0.95)],
    p99Ms: a[Math.floor(a.length * 0.99)],
    maxMs: a.at(-1),
  }
}

/** Same Electron process/machine; separate temporary stores and offline synthetic pages. */
export async function runGptProPerformanceCase(browser: BrowserController, profileID: string, root: string) {
  const promptChars = Math.min(100_000, Math.max(9, Number(process.env.GPT_BENCH_PROMPT_CHARS) || 9))
  const histories: GptProJob[] = Array.from({ length: 32 }, (_, i) => ({
    id: `history-${i}`,
    owner: "synthetic",
    requestID: String(i),
    prompt: "s".repeat(promptChars),
    phase: "completed",
    url: GPT_PRO_URL,
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    submitted: true,
    text: "x".repeat(100_000),
    html: "y".repeat(200_000),
  }))
  const streams = Array.from({ length: 4 }, (_, i) => ({
    ...histories[i],
    id: `stream-${i}`,
    phase: "generating" as const,
  }))
  const jobs = [...histories, ...streams]
  const legacy = new Store({ cwd: root, name: "synthetic-legacy-benchmark" })
  legacy.set("jobs", jobs)
  const baseline: number[] = []
  for (let i = 0; i < 20; i++) {
    streams.forEach((job) => {
      job.text += "a"
      job.revision++
      job.updatedAt++
    })
    const t = performance.now()
    legacy.set("jobs", jobs)
    baseline.push(performance.now() - t)
  }
  const bodies = createGptProBodyJournal(join(root, "benchmark-bodies"), () => {}, { checkpointMs: 60_000 })
  const execution = createGptProExecutionStore(new DatabaseSync(join(root, "benchmark.db")), () => {}, 60_000, bodies)
  execution.load(() => jobs)
  const before = execution.metrics()
  const lag = monitorEventLoopDelay({ resolution: 1 })
  lag.enable()
  const commits: number[] = []
  for (let i = 0; i < 60; i++) {
    streams.forEach((job) => {
      job.text += "b"
      job.revision++
      job.updatedAt++
    })
    const t = performance.now()
    execution.save(jobs)
    commits.push(performance.now() - t)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const flushAt = performance.now()
  await execution.flush()
  const persistence = {
    oldFullHistoryWrite: stats(baseline),
    criticalCommits: stats(commits),
    checkpointMs: performance.now() - flushAt,
    criticalSerializedBytes: execution.metrics().serializedBytes - before.serializedBytes,
    bodies: bodies.metrics(),
  }
  await execution.close()
  await bodies.close()
  const ids = Array.from({ length: 4 }, (_, i) => `gpt-performance-page-${i}`)
  const blocks = 600
  const content = Array.from(
    { length: blocks },
    (_, i) =>
      `<p>Block ${i}: <span class="katex"><math><mrow><mi>x</mi><mo>+</mo><mfrac><mn>${i}</mn><mi>y</mi></mfrac></mrow></math></span><span class="tail">0</span></p>`,
  ).join("")
  await Promise.all(
    ids.map(async (id) => {
      await browser.openPage(id, profileID, `${GPT_PRO_URL}c/${id}`, { kind: "consultation" })
      await browser.cdp(id)!.waitForDocument()
      const conversation = `<article><div data-message-author-role="user" data-message-id="bench">Synthetic benchmark</div></article><article><div data-message-author-role="assistant" data-message-id="bench-answer" data-is-streaming="true"><div class="markdown">${content}</div></div></article>`
      await browser.cdp(id)!.evaluate(`document.querySelector('main').innerHTML=${JSON.stringify(conversation)}`)
    }),
  )
  const versions = new Map<string, string>()
  const roundTrips: number[] = [],
    encoding: number[] = []
  const measure = async (force: boolean) => {
    const rendering: number[] = [],
      recomputed: number[] = [],
      bytes: number[] = []
    for (let i = 0; i < 20; i++)
      await Promise.all(
        ids.map(async (id) => {
          const capture = chatGptCaptureExpression({ userID: "bench", knownVersion: versions.get(id), force })
          const t = performance.now()
          const value = await browser.cdp(id)!.evaluate<{ page: GptProPageState; elapsed: number }>(`(()=>{
        document.querySelector('.markdown p:last-child .tail').textContent=${JSON.stringify(String(i + (force ? 0 : 100)))};
        const t=performance.now();const page=${capture};return {page,elapsed:performance.now()-t}
      })()`)
          roundTrips.push(performance.now() - t)
          rendering.push(value.elapsed)
          recomputed.push(value.page.capture?.blocksRecomputed ?? -1)
          if (value.page.capture) versions.set(id, value.page.capture.version)
          const at = performance.now()
          bytes.push(Buffer.byteLength(JSON.stringify(value.page)))
          encoding.push(performance.now() - at)
        }),
      )
    return {
      renderer: stats(rendering),
      recomputedBlocksMin: Math.min(...recomputed),
      recomputedBlocksMax: Math.max(...recomputed),
      payloadBytesMax: Math.max(...bytes),
    }
  }
  const full = await measure(true),
    incremental = await measure(false)
  lag.disable()
  const result = {
    synthetic: true,
    promptChars,
    parallelPages: 4,
    blocksPerAnswer: blocks,
    persistence,
    capture: { full, incremental, roundTrip: stats(roundTrips), mainPayloadEncoding: stats(encoding) },
    mainEventLoopLag: { p95Ms: lag.percentile(95) / 1e6, p99Ms: lag.percentile(99) / 1e6, maxMs: lag.max / 1e6 },
  }
  for (const id of ids) browser.close(id, "synthetic-performance-finished")
  return result
}
