import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "pi.rpc" })
export type PiRecord = Record<string, unknown> & { type: string }

export type PiRpcOptions = {
  binary: string
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
}

/** Process-isolated transport shared by consult tools and future Pi UI bridges. */
export class PiRpcClient {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<string, { resolve: (record: PiRecord) => void; reject: (error: Error) => void }>()
  private listeners = new Set<(record: PiRecord) => void>()
  private failures = new Set<(error: Error) => void>()
  private sequence = 0
  private error?: Error
  private stderr = ""
  private closing?: Promise<void>
  private prompting = false
  private exited = false

  constructor(private readonly options: PiRpcOptions) {}

  async start(signal?: AbortSignal) {
    if (this.child) throw new Error("Pi RPC client already started")
    if (signal?.aborted) throw new Error("Pi consultation was aborted")
    const script = /\.[cm]?js$/.test(this.options.binary)
    const args = [...(script ? [this.options.binary] : []), "--mode", "rpc", ...(this.options.args ?? [])]
    log.info(`spawn cwd=${this.options.cwd} binary=${this.options.binary} args=${args.length}`)
    const child = spawn(script ? "node" : this.options.binary, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: "pipe",
      windowsHide: true,
    })
    this.child = child
    child.once("error", (error) => this.fail(new Error(`Pi startup failed: ${error.message}`)))
    child.once("close", (code, signal) => {
      this.exited = true
      log.info(`exit pid=${child.pid} code=${code} signal=${signal} closing=${!!this.closing}`)
      this.fail(new Error(`Pi exited code=${code} signal=${signal}${this.stderr ? `: ${this.stderr}` : ""}`))
    })
    child.stdin.on("error", (error) => this.fail(new Error(`Pi stdin failed: ${error.message}`)))
    child.stderr.on("data", (chunk: Buffer) => {
      const value = chunk.toString("utf8")
      this.stderr = (this.stderr + value).slice(-16000)
      log.debug(`stderr pid=${child.pid} text=${value.slice(0, 2000)}`)
    })
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) {
          this.fail(new Error("Pi RPC record exceeds 16 MiB"))
          void this.stop()
          return
        }
        this.receive(line)
      }
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        this.fail(new Error("Pi RPC record exceeds 16 MiB"))
        void this.stop()
      }
    })
    child.stdout.once("end", () => {
      buffer += decoder.end()
      if (buffer.trim()) this.receive(buffer)
    })
    // A response, not a startup sleep, proves the protocol is ready.
    const abort = () => this.fail(new Error("Pi startup was aborted"))
    signal?.addEventListener("abort", abort, { once: true })
    try {
      const state = await this.request({ type: "get_state" })
      log.info(`ready pid=${child.pid}`)
      return state
    } catch (error) {
      await this.stop()
      throw error
    } finally {
      signal?.removeEventListener("abort", abort)
    }
  }

  onEvent(listener: (record: PiRecord) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async request(command: PiRecord, timeoutMs = this.options.requestTimeoutMs ?? 30000): Promise<PiRecord> {
    if (this.error) throw this.error
    const id = `opencode-${++this.sequence}`
    log.debug(`request id=${id} type=${command.type}`)
    return new Promise<PiRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi RPC ${command.type} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (record) => {
          clearTimeout(timer)
          resolve(record)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.write({ ...command, id }).catch((error) => {
        this.pending.get(id)?.reject(error)
        this.pending.delete(id)
      })
    })
  }

  async prompt(message: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    if (this.prompting) throw new Error("Pi RPC prompt already running")
    if (options.signal?.aborted) throw new Error("Pi consultation was aborted")
    this.prompting = true
    const timeoutMs = options.timeoutMs ?? 600000
    let dispose = () => {}
    // Listen before sending: a fast Pi can settle before acknowledging prompt acceptance.
    const settled = new Promise<void>((resolve, reject) => {
      let lastError: string | undefined
      const unlisten = this.onEvent((record) => {
        if (record.type === "message_end") {
          const value = object(record.message)
          if (value?.role === "assistant") {
            lastError =
              value.stopReason === "error" || value.stopReason === "aborted"
                ? String(value.errorMessage ?? `Pi response ${value.stopReason}`)
                : undefined
          }
        }
        if (record.type === "agent_settled") {
          log.info(`settled pid=${this.child?.pid} failed=${!!lastError}`)
          if (lastError) reject(new Error(lastError))
          else resolve()
        }
      })
      const fail = (error: Error) => reject(error)
      this.failures.add(fail)
      const abort = () => {
        log.info(`abort pid=${this.child?.pid}`)
        reject(new Error("Pi consultation was aborted"))
      }
      options.signal?.addEventListener("abort", abort, { once: true })
      const timer = setTimeout(() => reject(new Error(`Pi consultation timed out after ${timeoutMs}ms`)), timeoutMs)
      dispose = () => {
        unlisten()
        this.failures.delete(fail)
        options.signal?.removeEventListener("abort", abort)
        clearTimeout(timer)
      }
    })
    // Attach a rejection handler even while waiting for prompt acceptance.
    void settled.catch(() => {})
    try {
      await Promise.race([
        this.request({ type: "prompt", message }, timeoutMs).then(async (response) => {
          const disposition = object(response.data)?.disposition
          if (disposition !== "handled") await settled
        }),
        settled.then(() => new Promise<void>(() => {})),
      ])
    } catch (error) {
      // Stop must not leave queued follow-ups running after the host cancels.
      await this.request({ type: "clear_queue" }, 1000).catch(() => {})
      await this.request({ type: "abort" }, 1000).catch(() => {})
      await this.stop()
      throw error
    } finally {
      dispose()
      this.prompting = false
    }
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing
    const child = this.child
    // Bun can leave exitCode null after a failed spawn; close is authoritative.
    if (!child || this.exited || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    log.info(`shutdown pid=${child.pid}`)
    this.closing = new Promise<void>((resolve) => {
      const terminate = setTimeout(() => child.kill("SIGTERM"), 1000)
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000)
      child.once("close", () => {
        clearTimeout(terminate)
        clearTimeout(kill)
        resolve()
      })
      child.stdin.end()
    })
    return this.closing
  }

  private async write(record: PiRecord) {
    if (this.error) throw this.error
    if (!this.child) throw new Error("Pi RPC client is not started")
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(JSON.stringify(record) + "\n", (error) => (error ? reject(error) : resolve()))
    })
  }

  private receive(line: string) {
    if (!line.trim()) return
    try {
      const value = object(JSON.parse(line))
      if (!value || typeof value.type !== "string") throw new Error("Expected a typed JSON object")
      const record = value as PiRecord
      if (record.type === "response") {
        const id = String(record.id ?? "")
        const pending = this.pending.get(id)
        this.pending.delete(id)
        log.debug(`response id=${id} command=${record.command} success=${record.success}`)
        if (record.success === false) pending?.reject(new Error(String(record.error ?? "Pi command failed")))
        else pending?.resolve(record)
        return
      }
      if (
        record.type === "extension_ui_request" &&
        ["select", "confirm", "input", "editor"].includes(String(record.method))
      ) {
        log.warn(`unsupported dialog cancelled id=${record.id} method=${record.method}`)
        void this.write({ type: "extension_ui_response", id: record.id, cancelled: true }).catch((error) =>
          this.fail(error),
        )
      }
      for (const listener of this.listeners) listener(record)
    } catch (error) {
      this.fail(new Error(`Invalid Pi RPC output: ${error instanceof Error ? error.message : String(error)}`))
      void this.stop()
    }
  }

  private fail(error: Error) {
    if (this.error) return
    this.error = error
    if (this.closing) log.debug(`closed pid=${this.child?.pid} error=${error.message}`)
    else log.warn(`failed pid=${this.child?.pid} error=${error.message}`)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const fail of this.failures) fail(error)
  }
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
