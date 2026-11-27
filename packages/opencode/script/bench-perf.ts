#!/usr/bin/env bun
// Perf budget harness, Winc xtask-bench style: every benchmark reports a
// `METRIC <name>=<median ms>` line and `--check` fails (exit 1) when any
// metric exceeds its entry in BUDGETS. Budgets sit ~4-5x above M-series local
// measurements so CI noise does not flake, while real regressions — an eager
// top-level import doubling CLI eval, a reverted O(n²) string append — still
// blow through them.
//
// Usage:  bun run bench:perf [--check]
// Env:    PERF_WARMUPS=1 PERF_RUNS=5
//         PERF_BUDGET_<NAME>=<ms> overrides a single budget (e.g. PERF_BUDGET_CLI_DEV_VERSION_MS=500)
import { Database as SQLite } from "bun:sqlite"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { mergePartDeltas } from "../src/server/event-merge"
import { appendStreamingText, clearStreamingText, hasStreamingText, streamingText } from "../src/session/streaming-text"

const check = process.argv.includes("--check")
const warmups = Number(Bun.env.PERF_WARMUPS ?? 1)
const runs = Number(Bun.env.PERF_RUNS ?? 5)

if (!Number.isInteger(warmups) || warmups < 0 || !Number.isInteger(runs) || runs < 1) {
  console.error("PERF_WARMUPS must be >= 0 and PERF_RUNS must be >= 1")
  process.exit(1)
}

const pkg = path.join(import.meta.dir, "..")
const binary = path.join(pkg, "dist", `opencode-${process.platform}-${process.arch}`, "bin", "opencode")

// Median budget per metric in milliseconds. Numbers next to each entry are
// the local M-series baseline this file was calibrated against.
const BUDGETS: Record<string, number> = {
  cli_binary_version_ms: 150, // ~27
  cli_binary_help_ms: 400, // ~104
  cli_dev_version_ms: 300, // ~39
  // JSC ropes make even a naive `text += delta` cheap (~3ms), so this guards
  // against pathological per-append materialization (join/serialize on every
  // token), not algorithmic complexity alone.
  streaming_text_200k_ms: 200, // ~3
  part_delta_merge_50k_ms: 100, // ~2
  sqlite_events_batched_ms: 60, // ~1; one immediate tx + 200 savepoints
}

function median(xs: number[]) {
  const s = xs.toSorted((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function spawnMs(argv: string[]) {
  const start = performance.now()
  const proc = Bun.spawn(argv, { cwd: pkg, stdout: "pipe", stderr: "pipe" })
  // yargs prints --help to stderr, so accept output on either stream.
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const ms = performance.now() - start
  if (code !== 0 || !(out + err).trim()) throw new Error(`bad spawn: ${argv.join(" ")} (exit ${code})`)
  return ms
}

const TOKEN = "lorem ip " // ~9 bytes, roughly a small LLM token

function streamingTextMs() {
  const key = { sessionID: "s", messageID: "m", partID: "p" }
  const start = performance.now()
  appendStreamingText(key, "", TOKEN)
  for (let i = 1; i < 200_000; i++) {
    hasStreamingText(key)
    appendStreamingText(key, "", TOKEN)
    if (i % 1000 === 0) streamingText(key)
  }
  const total = streamingText(key)
  clearStreamingText(key)
  if (total?.length !== 200_000 * TOKEN.length) throw new Error("streaming text corrupted")
  return performance.now() - start
}

function partDeltaMergeMs() {
  // Two interleaved parts plus periodic unrelated events: adjacency merges
  // most deltas but the merger still inspects every payload.
  const events = Array.from({ length: 50_000 }, (_, i) => ({
    payload: {
      id: `e${i}`,
      type: i % 250 === 249 ? "session.updated" : "message.part.delta",
      properties: {
        sessionID: "s",
        messageID: "m",
        partID: `p${i % 2}`,
        field: "text",
        delta: TOKEN,
      },
    },
  }))
  const start = performance.now()
  const merged = mergePartDeltas(
    events,
    (e) => e.payload,
    (e, p) => ({ payload: p }),
  )
  if (!merged.length) throw new Error("merge produced nothing")
  return performance.now() - start
}

function sqliteBatchedMs() {
  // Mirrors src/sync: one immediate transaction per tick, each event inside
  // its own savepoint. 200 events ≈ a tool-heavy burst of part transitions.
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-perf-"))
  try {
    const db = new SQLite(path.join(dir, "bench.db"))
    db.exec("CREATE TABLE seq (id TEXT PRIMARY KEY, seq INTEGER)")
    db.exec("CREATE TABLE ev (id TEXT PRIMARY KEY, agg TEXT, seq INTEGER, data TEXT)")
    const select = db.prepare("SELECT seq FROM seq WHERE id = ?")
    const upsert = db.prepare(
      "INSERT INTO seq (id, seq) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq",
    )
    const insert = db.prepare("INSERT INTO ev (id, agg, seq, data) VALUES (?, ?, ?, ?)")
    db.exec("BEGIN IMMEDIATE")
    const start = performance.now()
    for (let i = 0; i < 200; i++) {
      db.exec("SAVEPOINT ev")
      try {
        const agg = `a${i % 8}`
        const seq = ((select.get(agg) as { seq: number } | undefined)?.seq ?? -1) + 1
        upsert.run(agg, seq)
        insert.run(`e${i}`, agg, seq, `{"i":${i}}`)
        db.exec("RELEASE ev")
      } catch (e) {
        db.exec("ROLLBACK TO ev")
        db.exec("RELEASE ev")
        throw e
      }
    }
    db.exec("COMMIT")
    db.close()
    return performance.now() - start
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

type Bench = [name: string, fn: () => number | Promise<number>]
const binaryBenches: Bench[] = existsSync(binary)
  ? [
      ["cli_binary_version_ms", () => spawnMs([binary, "--version"])],
      ["cli_binary_help_ms", () => spawnMs([binary, "--help"])],
    ]
  : []
const benches: Bench[] = [
  ...binaryBenches,
  ["cli_dev_version_ms", () => spawnMs(["bun", "run", "--conditions=browser", "./src/index.ts", "--version"])],
  ["streaming_text_200k_ms", streamingTextMs],
  ["part_delta_merge_50k_ms", partDeltaMergeMs],
  ["sqlite_events_batched_ms", sqliteBatchedMs],
]

if (!existsSync(binary)) console.log(`bench:perf binary ${binary} not found, skipping binary benches`)

const violations: string[] = []
for (const [name, fn] of benches) {
  const timings: number[] = []
  for (const i of Array.from({ length: warmups + runs }, (_, i) => i)) {
    const ms = await fn()
    if (i >= warmups) timings.push(ms)
  }
  const med = median(timings)
  const best = Math.min(...timings)
  const worst = Math.max(...timings)
  const budget = Number(Bun.env[`PERF_BUDGET_${name.toUpperCase()}`] ?? BUDGETS[name])
  const verdict =
    budget === undefined ? "" : med <= budget ? ` (budget ${budget}ms ok)` : ` (budget ${budget}ms EXCEEDED)`
  console.log(
    `bench:perf ${name} median=${med.toFixed(1)}ms best=${best.toFixed(1)}ms worst=${worst.toFixed(1)}ms${verdict}`,
  )
  console.log(`METRIC ${name}=${med.toFixed(1)}`)
  if (check && budget !== undefined && med > budget) violations.push(`${name} ${med.toFixed(1)}ms > ${budget}ms`)
}

if (violations.length) {
  console.error(`bench:perf budget violations:\n  ${violations.join("\n  ")}`)
  process.exit(1)
}
