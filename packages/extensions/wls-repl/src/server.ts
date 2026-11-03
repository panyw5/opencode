import {
  defineServerExtension,
  type ExtensionHooks,
  type ExtensionHost,
  type ExtensionPluginInput,
  type ExtensionService,
} from "@opencode-ai/extension-kit/server"
import { tool } from "@opencode-ai/plugin/tool"
import { spawn, spawnSync } from "node:child_process"
import { createInterface } from "node:readline"
import { appendFile, mkdtemp, rm } from "node:fs/promises"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"

const EXTENSION_ID = "local.wls-repl"
const MESSAGE_EVENT = `${EXTENSION_ID}/message`
const READY_TIMEOUT_MS = 30_000
const PING_TIMEOUT_MS = 8_000
const DEFAULT_STATEMENT_TIMEOUT_SECONDS = 60
const DEFAULT_MAX_KERNELS = 2
const PROTOCOL_PREFIX = "\x1e"
const NONCE_PATTERN = /^[0-9a-f]{8}$/
const STDERR_NOISE =
  /^\s*(FrontEndObject::notavail|A front end is not available|General::stop|will be suppressed during this calculation)/

const bridgePath = fileURLToPath(new URL("./bridge.wls", import.meta.url))

/**
 * A running `wolframscript -file bridge.wls` child. Abstracted so tests can
 * drive the protocol without a real Wolfram installation.
 */
export type KernelHandle = {
  readonly pid: number | undefined
  onStdoutLine(listener: (line: string) => void): () => void
  onStderrLine(listener: (line: string) => void): () => void
  onExit(listener: (code: number | null) => void): () => void
  onError(listener: (error: Error) => void): () => void
  kill(signal?: "TERM" | "KILL"): void
}

export type SpawnKernelOptions = {
  ctlPath: string
  bridgePath: string
  wolframscriptPath: string
}

export type SpawnKernel = (options: SpawnKernelOptions) => KernelHandle

/**
 * Real spawn. The child runs detached as its own process group so killing
 * the group also takes down the `tail -f` helper the kernel spawns for its
 * control channel.
 */
export const defaultSpawnKernel: SpawnKernel = ({ ctlPath, bridgePath, wolframscriptPath }) => {
  const child = spawn(wolframscriptPath, ["-file", bridgePath], {
    env: { ...process.env, WLS_REPL_CTL: ctlPath },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  const stdout = createInterface({ input: child.stdout! })
  const stderr = createInterface({ input: child.stderr! })
  const listeners = { out: new Set<(line: string) => void>(), err: new Set<(line: string) => void>() }
  const exits = new Set<(code: number | null) => void>()
  const errors = new Set<(error: Error) => void>()
  stdout.on("line", (line) => {
    for (const listener of listeners.out) listener(line)
  })
  stderr.on("line", (line) => {
    for (const listener of listeners.err) listener(line)
  })
  child.once("exit", (code) => {
    for (const listener of exits) listener(code)
  })
  child.once("error", (error) => {
    for (const listener of errors) listener(error)
  })
  return {
    pid: child.pid,
    onStdoutLine: (listener) => {
      listeners.out.add(listener)
      return () => listeners.out.delete(listener)
    },
    onStderrLine: (listener) => {
      listeners.err.add(listener)
      return () => listeners.err.delete(listener)
    },
    onExit: (listener) => {
      exits.add(listener)
      return () => exits.delete(listener)
    },
    onError: (listener) => {
      errors.add(listener)
      return () => errors.delete(listener)
    },
    kill: (signal = "TERM") => {
      const group = child.pid ?? 0
      const unix = signal === "KILL" ? "SIGKILL" : "SIGTERM"
      const send = () => {
        try {
          if (group) process.kill(-group, unix)
        } catch {
          child.kill(unix)
        }
      }
      send()
      if (signal === "TERM") {
        // Backstop for fire-and-forget kills; stopKernel escalates eagerly.
        setTimeout(() => {
          try {
            if (group) process.kill(-group, "SIGKILL")
          } catch {
            /* already gone */
          }
        }, 2_000).unref?.()
      }
    },
  }
}

export type WlsKernelStatus = "starting" | "ready" | "running" | "paused" | "error" | "stopped"

type Kernel = {
  path: string
  ctlDir: string
  ctlPath: string
  handle: KernelHandle
  nonce: string | undefined
  status: WlsKernelStatus
  version: string | undefined
  pausedLine: number | undefined
  lastActivity: number
  writes: Promise<void>
  exited: boolean
  exitCode: number | undefined
}

export type WlsServiceDeps = {
  spawnKernel?: SpawnKernel
  now?: () => number
}

type WlsSettings = {
  wolframscriptPath: string
  statementTimeoutSeconds: number
  maxKernels: number
  exposeTool: "always" | "never"
}

function readSettings(host: ExtensionHost): WlsSettings {
  const raw = (host.settings.get() ?? {}) as Record<string, unknown>
  const path =
    typeof raw.wolframscriptPath === "string" && raw.wolframscriptPath.trim() !== ""
      ? raw.wolframscriptPath
      : "wolframscript"
  const timeout =
    typeof raw.statementTimeoutSeconds === "number" && raw.statementTimeoutSeconds > 0
      ? raw.statementTimeoutSeconds
      : DEFAULT_STATEMENT_TIMEOUT_SECONDS
  const max =
    typeof raw.maxKernels === "number" && raw.maxKernels >= 1 ? Math.floor(raw.maxKernels) : DEFAULT_MAX_KERNELS
  const exposeTool = raw.exposeTool === "never" ? "never" : "always"
  return { wolframscriptPath: path, statementTimeoutSeconds: timeout, maxKernels: max, exposeTool }
}

function rpcError(code: string, message: string): Error {
  const error = new Error(message) as Error & { name: string; code?: string }
  error.name = "ExtensionRpcError"
  error.code = code
  return error
}

function asPath(input: unknown): string {
  const value = (input as { path?: unknown } | null | undefined)?.path
  if (typeof value !== "string" || value.trim() === "") {
    throw rpcError("invalid_path", "a non-empty `path` string is required")
  }
  return resolve(value)
}

function asBreakpoints(input: unknown): number[] {
  const value = (input as { breakpoints?: unknown } | null | undefined)?.breakpoints
  if (value === undefined) return []
  if (!Array.isArray(value)) throw rpcError("invalid_breakpoints", "`breakpoints` must be an array of line numbers")
  const lines = value.filter((line): line is number => Number.isInteger(line) && line > 0)
  return [...new Set(lines)]
}

type KernelRecord = { kernelPid: number; hostPid: number; ctlPath: string }

function kernelRecordsFile(dataDir: string): string {
  return join(dataDir, "kernel-pids.json")
}

function readKernelRecords(file: string): KernelRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (record): record is KernelRecord =>
            record !== null &&
            typeof record === "object" &&
            typeof (record as KernelRecord).kernelPid === "number" &&
            typeof (record as KernelRecord).hostPid === "number",
        )
      : []
  } catch {
    return []
  }
}

function writeKernelRecords(file: string, records: KernelRecord[]): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, JSON.stringify(records))
  } catch (error) {
    /* bookkeeping is best-effort */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Kills kernels left behind by host processes that died without disposing
 * (crash, SIGKILL). A record is only acted on when its recorded host pid is
 * provably dead, so concurrent live hosts never reap each other's kernels.
 */
function sweepStaleKernels(host: ExtensionHost): void {
  const file = kernelRecordsFile(host.dataDir)
  const records = readKernelRecords(file)
  const keep: KernelRecord[] = []
  for (const record of records) {
    if (record.hostPid === process.pid || isProcessAlive(record.hostPid)) {
      keep.push(record)
      continue
    }
    const probe = spawnSync("ps", ["-o", "command=", "-p", String(record.kernelPid)], { encoding: "utf8" })
    const command = probe.stdout ?? ""
    if (command.includes("bridge.wls")) {
      host.log.warn("wls-repl killing stale kernel from a dead host process", { pid: record.kernelPid })
      try {
        process.kill(record.kernelPid, "SIGKILL")
      } catch {
        /* already gone */
      }
    }
  }
  if (keep.length !== records.length) writeKernelRecords(file, keep)
}

/**
 * Builds the process-level service. Kept as a factory so tests can inject a
 * fake kernel handle.
 */
export function createWlsService(host: ExtensionHost, deps: WlsServiceDeps = {}): ExtensionService {
  const spawnKernel = deps.spawnKernel ?? defaultSpawnKernel
  const now = deps.now ?? Date.now
  const kernels = new Map<string, Kernel>()
  sweepStaleKernels(host)
  const recordsFile = kernelRecordsFile(host.dataDir)

  const emit = (payload: Record<string, unknown>) => {
    host.emit(MESSAGE_EVENT, payload)
    host.log.debug("wls-repl event", { type: String(payload.type ?? payload.kind), path: String(payload.path ?? "") })
  }

  const handleProtocol = (kernel: Kernel, message: Record<string, unknown> & { type?: string }) => {
    switch (message.type) {
      case "ready":
        kernel.nonce = typeof message.nonce === "string" ? message.nonce : undefined
        kernel.version = typeof message.version === "string" ? message.version : undefined
        if (kernel.status === "starting") kernel.status = "ready"
        break
      case "paused":
        kernel.status = "paused"
        kernel.pausedLine = typeof message.line === "number" ? message.line : undefined
        kernel.lastActivity = now()
        break
      case "done":
        kernel.status = "ready"
        kernel.pausedLine = undefined
        kernel.lastActivity = now()
        break
      case "bridge-error":
        kernel.status = "error"
        break
    }
    emit({ path: kernel.path, kind: "protocol", ...message })
  }

  const attach = (kernel: Kernel) => {
    kernel.handle.onStdoutLine((line) => {
      if (line.startsWith(PROTOCOL_PREFIX)) {
        if (kernel.nonce === undefined && NONCE_PATTERN.test(line.slice(1, 9))) {
          kernel.nonce = line.slice(1, 9)
        }
        if (kernel.nonce !== undefined && line.startsWith(PROTOCOL_PREFIX + kernel.nonce)) {
          try {
            const message = JSON.parse(line.slice(1 + kernel.nonce.length))
            if (message && typeof message === "object") {
              handleProtocol(kernel, message as Record<string, unknown> & { type?: string })
              return
            }
          } catch (error) {
            host.log.warn("wls-repl invalid protocol JSON", { path: kernel.path, error: String(error) })
            return
          }
        }
      }
      emit({ path: kernel.path, kind: "output", text: line })
    })
    kernel.handle.onStderrLine((line) => {
      // wolframscript prints front-end availability warnings on every start;
      // they are startup noise, not user diagnostics.
      if (STDERR_NOISE.test(line)) return
      emit({ path: kernel.path, kind: "stderr", text: line })
    })
    kernel.handle.onError((error) => {
      host.log.error("wls-repl kernel spawn error", { path: kernel.path, error: String(error) })
      kernel.status = "error"
      emit({ path: kernel.path, kind: "protocol", type: "kernel-error", text: String(error) })
    })
    kernel.handle.onExit((code) => {
      kernel.exited = true
      kernel.exitCode = code ?? undefined
      kernel.status = "stopped"
      kernel.pausedLine = undefined
      host.log.info("wls-repl kernel exited", { path: kernel.path, code: code ?? -1 })
      emit({ path: kernel.path, kind: "protocol", type: "kernel-exit", code: code ?? undefined })
    })
  }

  const stopKernel = async (kernel: Kernel, reason: string): Promise<boolean> => {
    if (kernel.status === "stopped" || kernel.exited) {
      kernels.delete(kernel.path)
      await rm(kernel.ctlDir, { recursive: true, force: true }).catch(() => undefined)
      writeKernelRecords(
        recordsFile,
        readKernelRecords(recordsFile).filter((record) => record.ctlPath !== kernel.ctlPath),
      )
      return false
    }
    host.log.info("wls-repl stopping kernel", { path: kernel.path, reason })
    kernels.delete(kernel.path)
    const exited = new Promise<void>((resolvePromise) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolvePromise()
      }
      kernel.handle.onExit(() => done())
      setTimeout(done, 1_500).unref?.()
    })
    // Graceful first: an idle bridge quits on the shutdown command. A kernel
    // blocked mid-statement will not read it, so signals follow.
    void send(kernel, { op: "shutdown" })
    await new Promise((resolveGrace) => setTimeout(resolveGrace, 400))
    if (kernel.exited) return true
    kernel.handle.kill()
    await exited
    // wolframscript can ignore SIGTERM; escalate inside the awaited path so
    // a quickly-exiting host process cannot leave an orphan behind.
    if (!kernel.exited) {
      kernel.handle.kill("KILL")
      await new Promise((resolveKill) => {
        const done = () => resolveKill(undefined)
        kernel.handle.onExit(done)
        setTimeout(done, 1_500).unref?.()
      })
    }
    await rm(kernel.ctlDir, { recursive: true, force: true }).catch(() => undefined)
    writeKernelRecords(
      recordsFile,
      readKernelRecords(recordsFile).filter((record) => record.ctlPath !== kernel.ctlPath),
    )
    return true
  }

  const evictIfNeeded = (settings: WlsSettings, keepPath: string) => {
    if (kernels.size < settings.maxKernels) return
    const candidates = [...kernels.values()]
      .filter((kernel) => kernel.path !== keepPath)
      .sort((a, b) => a.lastActivity - b.lastActivity)
    while (kernels.size >= settings.maxKernels && candidates.length > 0) {
      const victim = candidates.shift()
      if (!victim) break
      void stopKernel(victim, "evicted")
    }
  }

  const ensureKernel = async (path: string): Promise<Kernel> => {
    const existing = kernels.get(path)
    if (existing && !existing.exited) return existing
    if (existing) await stopKernel(existing, "replacing dead kernel")
    const settings = readSettings(host)
    evictIfNeeded(settings, path)
    const ctlDir = await mkdtemp(join(tmpdir(), "wls-repl-"))
    const ctlPath = join(ctlDir, "ctl")
    await appendFile(ctlPath, "")
    host.log.info("wls-repl spawning kernel", { path, wolframscript: settings.wolframscriptPath })
    const kernel: Kernel = {
      path,
      ctlDir,
      ctlPath,
      handle: spawnKernel({ ctlPath, bridgePath, wolframscriptPath: settings.wolframscriptPath }),
      nonce: undefined,
      status: "starting",
      version: undefined,
      pausedLine: undefined,
      lastActivity: now(),
      writes: Promise.resolve(),
      exited: false,
      exitCode: undefined,
    }
    kernels.set(path, kernel)
    attach(kernel)
    if (kernel.handle.pid !== undefined) {
      const records = readKernelRecords(recordsFile).filter((record) => record.ctlPath !== kernel.ctlPath)
      records.push({ kernelPid: kernel.handle.pid, hostPid: process.pid, ctlPath: kernel.ctlPath })
      writeKernelRecords(recordsFile, records)
    }
    return kernel
  }

  const awaitReady = async (kernel: Kernel, timeoutMs = READY_TIMEOUT_MS): Promise<void> => {
    if (kernel.exited) {
      throw rpcError("kernel_died", `the wolframscript kernel exited (code ${kernel.exitCode ?? "unknown"})`)
    }
    if (kernel.status === "ready" || kernel.status === "running" || kernel.status === "paused") return
    const deadline = now() + timeoutMs
    while (kernel.status === "starting" && !kernel.exited && now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    }
    if (kernel.exited) {
      throw rpcError("kernel_died", `the wolframscript kernel exited (code ${kernel.exitCode ?? "unknown"})`)
    }
    if (kernel.status === "starting") {
      throw rpcError("kernel_start_timeout", `wolframscript kernel did not become ready within ${timeoutMs}ms`)
    }
    if (kernel.status === "error") {
      throw rpcError("kernel_error", "wolframscript kernel reported an error before becoming ready")
    }
  }

  const send = (kernel: Kernel, command: Record<string, unknown>): Promise<void> => {
    kernel.writes = kernel.writes.then(() =>
      appendFile(kernel.ctlPath, `${JSON.stringify(command)}\n`).catch((error) => {
        host.log.warn("wls-repl ctl write failed", { path: kernel.path, error: String(error) })
      }),
    )
    return kernel.writes
  }

  const pingKernel = async (kernel: Kernel): Promise<void> => {
    if (kernel.exited || kernel.status === "stopped") {
      throw rpcError("kernel_died", "kernel is not running")
    }
    const id = randomUUID()
    return new Promise<void>((resolvePing, rejectPing) => {
      const timer = setTimeout(() => {
        off()
        rejectPing(rpcError("kernel_ping_timeout", `kernel did not answer ping within ${PING_TIMEOUT_MS}ms`))
      }, PING_TIMEOUT_MS)
      const onLine = (line: string) => {
        if (!line.startsWith(PROTOCOL_PREFIX) || kernel.nonce === undefined) return
        if (!line.startsWith(PROTOCOL_PREFIX + kernel.nonce)) return
        try {
          const message = JSON.parse(line.slice(1 + kernel.nonce.length))
          if (message?.type === "pong" && message.id === id) {
            clearTimeout(timer)
            off()
            resolvePing()
          }
        } catch {
          /* non-JSON protocol line: ignore */
        }
      }
      const off = kernel.handle.onStdoutLine(onLine)
      void send(kernel, { id, op: "ping" })
    })
  }

  const service: ExtensionService = {
    rpc: {
      "kernel.status": async (input) => {
        const path = asPath(input)
        const kernel = kernels.get(path)
        if (!kernel) {
          return { path, status: "stopped" as WlsKernelStatus, kernelRunning: false }
        }
        return {
          path,
          status: kernel.status,
          kernelRunning: !kernel.exited,
          pid: kernel.handle.pid ?? undefined,
          version: kernel.version,
          pausedLine: kernel.pausedLine,
        }
      },

      "kernel.run": async (input) => {
        const path = asPath(input)
        const code = (input as { code?: unknown } | null | undefined)?.code
        if (typeof code !== "string") throw rpcError("invalid_code", "`code` must be a string")
        const breakpoints = asBreakpoints(input)
        const settings = readSettings(host)
        const timeoutSeconds =
          typeof (input as { timeoutSeconds?: unknown }).timeoutSeconds === "number" &&
          (input as { timeoutSeconds: number }).timeoutSeconds > 0
            ? (input as { timeoutSeconds: number }).timeoutSeconds
            : settings.statementTimeoutSeconds
        const kernel = await ensureKernel(path)
        await awaitReady(kernel)
        const runId = randomUUID()
        if (kernel.status === "running" || kernel.status === "paused") {
          throw rpcError("kernel_busy", "a run is already in progress; abort or wait for it to finish")
        }
        kernel.status = "running"
        kernel.pausedLine = undefined
        await send(kernel, { id: runId, op: "run", code, breakpoints, timeoutSeconds })
        host.log.info("wls-repl run started", { path, runId, breakpointCount: breakpoints.length })
        return { started: true, runId, pid: kernel.handle.pid ?? undefined }
      },

      "kernel.eval": async (input) => {
        const path = asPath(input)
        const code = (input as { code?: unknown } | null | undefined)?.code
        if (typeof code !== "string") throw rpcError("invalid_code", "`code` must be a string")
        const kernel = await ensureKernel(path)
        await awaitReady(kernel)
        const id = randomUUID()
        await send(kernel, { id, op: "eval", code, timeoutSeconds: readSettings(host).statementTimeoutSeconds })
        return { queued: true, id }
      },

      "kernel.continue": async (input) => {
        const kernel = kernels.get(asPath(input))
        if (!kernel || kernel.exited) throw rpcError("kernel_died", "kernel is not running")
        if (kernel.status !== "paused") throw rpcError("not_paused", "kernel is not paused at a breakpoint")
        await send(kernel, { op: "continue" })
        return { ok: true }
      },

      "kernel.step": async (input) => {
        const kernel = kernels.get(asPath(input))
        if (!kernel || kernel.exited) throw rpcError("kernel_died", "kernel is not running")
        if (kernel.status !== "paused") throw rpcError("not_paused", "kernel is not paused at a breakpoint")
        await send(kernel, { op: "step" })
        return { ok: true }
      },

      "kernel.abort": async (input) => {
        const kernel = kernels.get(asPath(input))
        if (!kernel || kernel.exited) throw rpcError("kernel_died", "kernel is not running")
        if (kernel.status !== "paused") throw rpcError("not_paused", "kernel is not paused at a breakpoint")
        await send(kernel, { op: "abort" })
        return { ok: true }
      },

      "kernel.restart": async (input) => {
        const path = asPath(input)
        const existing = kernels.get(path)
        if (existing) await stopKernel(existing, "restart")
        const kernel = await ensureKernel(path)
        await awaitReady(kernel)
        return { status: kernel.status, pid: kernel.handle.pid ?? undefined }
      },

      "kernel.stop": async (input) => {
        const kernel = kernels.get(asPath(input))
        if (!kernel) return { stopped: false }
        const stopped = await stopKernel(kernel, "rpc stop")
        return { stopped }
      },

      "kernel.ping": async (input) => {
        const kernel = kernels.get(asPath(input))
        if (!kernel || kernel.exited) throw rpcError("kernel_died", "kernel is not running")
        await pingKernel(kernel)
        return { ok: true, pid: kernel.handle.pid ?? undefined }
      },

      /**
       * Evaluates code and resolves with the final result text (used by the
       * wolfram_eval tool, which cannot consume event-stream replies).
       */
      "kernel.evalAwait": async (reqInput) => {
        const path = asPath(reqInput)
        const code = (reqInput as { code?: unknown } | null | undefined)?.code
        if (typeof code !== "string") throw rpcError("invalid_code", "`code` must be a string")
        const timeoutSeconds = readSettings(host).statementTimeoutSeconds
        const kernel = await ensureKernel(path)
        await awaitReady(kernel)
        const id = randomUUID()
        const deadlineMs = now() + (timeoutSeconds + 30) * 1_000
        return new Promise<{ ok: boolean; text: string }>((resolveEval, rejectEval) => {
          const finish = (error: Error | null, result?: { ok: boolean; text: string }) => {
            off()
            clearTimeout(timer)
            if (error) rejectEval(error)
            else resolveEval(result ?? { ok: true, text: "" })
          }
          const timer = setTimeout(() => {
            finish(rpcError("eval_timeout", `evaluation did not finish within ${timeoutSeconds + 30}s`))
          }, deadlineMs - now())
          timer.unref?.()
          const onLine = (line: string) => {
            if (kernel.nonce === undefined || !line.startsWith(PROTOCOL_PREFIX + kernel.nonce)) return
            try {
              const message = JSON.parse(line.slice(1 + kernel.nonce.length))
              if ((message?.type === "eval-result" || message?.type === "inspect-result") && message?.id === id) {
                finish(null, { ok: message.ok !== false, text: String(message.text ?? "") })
              }
            } catch {
              /* non-JSON protocol line: ignore */
            }
          }
          const off = kernel.handle.onStdoutLine(onLine)
          void send(kernel, { id, op: "eval", code, timeoutSeconds })
        })
      },
    },

    dispose: async () => {
      host.log.info("wls-repl disposing", { kernels: kernels.size })
      await Promise.all([...kernels.values()].map((kernel) => stopKernel(kernel, "dispose")))
    },
  }

  return service
}

/**
 * Kernel key for agent/tool evaluations that are not tied to a specific
 * .wls file: one shared kernel per project directory. When the tool names a
 * `path`, that file's kernel is used instead, so the agent and the user
 * share state for the file they are both looking at.
 */
function toolKernelKey(directory: string): string {
  return resolve(join(directory, ".wolfram-tool"))
}

const extension = defineServerExtension({
  id: EXTENSION_ID,

  /** Process-level service: one wolframscript kernel per open .wls file. */
  async activate(host) {
    host.log.info("activating wls-repl server part", { bridgePath })
    return createWlsService(host)
  },

  /** Instance-level hooks: the wolfram_eval LLM tool. */
  async server(input: ExtensionPluginInput): Promise<ExtensionHooks> {
    const hooks: ExtensionHooks = {
      tool: {
        wolfram_eval: tool({
          description:
            "Evaluate Wolfram Language code in a persistent local wolframscript kernel. " +
            "Variables persist between calls. Optionally pass `path` of a .wls file to use " +
            "the same kernel the user has open in the WolframScript REPL viewer, sharing variables with them.",
          args: {
            code: tool.schema.string().describe("Wolfram Language code to evaluate"),
            path: tool.schema
              .string()
              .optional()
              .describe("Absolute path of a .wls file whose kernel to share (optional)"),
          },
          execute: async (args, ctx) => {
            const extensionHost = input.extension
            const settings = (extensionHost.settings.get() ?? {}) as Record<string, unknown>
            if (settings.exposeTool === "never") {
              return "wolfram_eval is disabled (exposeTool setting is set to never)."
            }
            const rpc = extensionHost.service?.rpc
            const evalAwait = rpc?.["kernel.evalAwait"]
            if (!evalAwait) {
              return "wolfram_eval is not available (extension service is not active)."
            }
            const path =
              typeof args.path === "string" && args.path.trim() !== ""
                ? resolve(args.path)
                : toolKernelKey(input.directory)
            try {
              const result = (await evalAwait({ path, code: args.code }, { directory: input.directory } as Parameters<
                typeof evalAwait
              >[1])) as { ok: boolean; text: string }
              const text = result.text.length > 4_000 ? result.text.slice(0, 4_000) + "\n… (truncated)" : result.text
              return `wolfram> ${args.code}\n${result.ok ? text : `error: ${text}`}`
            } catch (error) {
              return `wolfram_eval failed: ${error instanceof Error ? error.message : String(error)}`
            }
          },
        }),
      },
    }
    return hooks
  },
})

export default extension
