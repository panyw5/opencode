import { appendFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import type { ExtensionHost } from "@opencode-ai/extension-kit/server"
import { hostSpawnKernel, type KernelHandle, type SpawnKernel } from "../../wls-repl/src/server"

export type Output = { ok: boolean; text: string; printed: string; image?: string }
type Kernel = {
  handle: KernelHandle
  dir: string
  ctl: string
  ready: Promise<void>
  request?: { id: string; resolve(output: Output): void; reject(error: Error): void }
  exited: boolean
}

export class NotebookKernels {
  private kernels = new Map<string, Promise<Kernel>>()
  private busy = new Set<string>()
  private disposed = false

  constructor(
    private host: ExtensionHost,
    private spawn: SpawnKernel = hostSpawnKernel(host),
  ) {}

  private async start(path: string): Promise<Kernel> {
    if (this.disposed) throw new Error("Notebook extension is stopped")
    const existing = this.kernels.get(path)
    if (existing) return existing
    const settings = this.host.settings.get()
    const max =
      typeof settings.maxKernels === "number" && Number.isFinite(settings.maxKernels)
        ? Math.max(1, Math.floor(settings.maxKernels))
        : 2
    if (this.kernels.size >= max)
      throw new Error(`Maximum ${max} notebook kernels reached. Stop another notebook kernel first.`)
    const pending = this.launch(path)
    this.kernels.set(path, pending)
    void pending.catch(() => {
      if (this.kernels.get(path) === pending) this.kernels.delete(path)
    })
    return pending
  }

  private async launch(path: string): Promise<Kernel> {
    const dir = await mkdtemp(join(tmpdir(), "oc-notebook-"))
    const ctl = join(dir, "control")
    await appendFile(ctl, "")
    const settings = this.host.settings.get()
    const executable =
      typeof settings.wolframscriptPath === "string" && settings.wolframscriptPath.trim()
        ? settings.wolframscriptPath
        : "wolframscript"
    this.host.log.info("notebook kernel starting", { path, executable })
    let handle: KernelHandle
    try {
      handle = this.spawn({
        ctlPath: ctl,
        bridgePath: fileURLToPath(new URL("./bridge.wls", import.meta.url)),
        wolframscriptPath: executable,
      })
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
    let ready!: () => void
    let fail!: (error: Error) => void
    const kernel: Kernel = {
      handle,
      dir,
      ctl,
      exited: false,
      ready: new Promise<void>((resolve, reject) => {
        ready = resolve
        fail = reject
      }),
    }
    const timer = setTimeout(() => fail(new Error("Wolfram kernel startup timed out (30s)")), 30_000)
    let nonce: string | undefined
    handle.onStdoutLine((line) => {
      if (!line.startsWith("\x1e")) {
        this.host.log.debug("notebook kernel stdout", { path, text: line.slice(0, 1000) })
        return
      }
      try {
        const token = line.slice(1, 9)
        const message = JSON.parse(line.slice(9))
        if (!nonce && message.type === "ready" && /^[0-9a-f]{8}$/.test(token)) {
          nonce = token
          ready()
          this.host.log.info("notebook kernel ready", { path, pid: handle.pid ?? -1 })
        }
        if (token !== nonce || message.type !== "result" || message.id !== kernel.request?.id) return
        kernel.request!.resolve({
          ok: message.ok === true,
          text: String(message.text ?? ""),
          printed: String(message.printed ?? ""),
          ...(typeof message.image === "string" && message.image ? { image: message.image } : {}),
        })
      } catch (error) {
        this.host.log.warn("notebook protocol decode failed", { path, error: String(error) })
      }
    })
    handle.onStderrLine((line) => this.host.log.warn("notebook kernel stderr", { path, text: line.slice(0, 1000) }))
    const died = (error: Error) => {
      kernel.exited = true
      fail(error)
      kernel.request?.reject(error)
      this.host.log.info("notebook kernel exited", { path, error: error.message })
      void this.kernels
        .get(path)
        ?.then((current) => {
          if (current === kernel) this.kernels.delete(path)
        })
        .catch(() => {})
      void rm(dir, { recursive: true, force: true })
    }
    handle.onExit((code) => died(new Error(`Wolfram kernel stopped (${code ?? "signal"})`)))
    handle.onError((error) =>
      died(
        new Error(
          `Cannot start wolframscript: ${error.message}. Configure wolframscriptPath and check your Wolfram license.`,
        ),
      ),
    )
    try {
      await kernel.ready
      return kernel
    } catch (error) {
      handle.kill("KILL")
      await rm(dir, { recursive: true, force: true })
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async evaluate(path: string, code: string, signal: AbortSignal): Promise<Output> {
    if (this.busy.has(path)) throw new Error("Notebook kernel is busy. Wait or stop it before running another cell.")
    if (signal.aborted) throw new Error("Evaluation cancelled")
    this.busy.add(path)
    try {
      const kernel = await this.start(path)
      if (signal.aborted || kernel.exited) throw new Error("Evaluation cancelled or kernel stopped")
      const raw = this.host.settings.get().timeoutSeconds
      const seconds = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3600) : 60
      const id = randomUUID()
      this.host.log.info("notebook evaluation started", { path, id, characters: code.length })
      return await new Promise<Output>((resolve, reject) => {
        const finish = (error?: Error, result?: Output) => {
          clearTimeout(timer)
          signal.removeEventListener("abort", abort)
          kernel.request = undefined
          if (error) reject(error)
          else resolve(result!)
        }
        const abort = () => {
          finish(new Error("Evaluation cancelled; kernel reset"))
          void this.stop(path)
        }
        const timer = setTimeout(
          () => {
            finish(new Error("Evaluation timed out; kernel reset"))
            void this.stop(path)
          },
          (seconds + 15) * 1000,
        )
        signal.addEventListener("abort", abort, { once: true })
        kernel.request = { id, resolve: (output) => finish(undefined, output), reject: (error) => finish(error) }
        void appendFile(kernel.ctl, JSON.stringify({ id, path, code, timeoutSeconds: seconds }) + "\n").catch((error) =>
          finish(error),
        )
      })
    } finally {
      this.busy.delete(path)
      this.host.log.info("notebook evaluation finished", { path })
    }
  }

  async stop(path: string) {
    const pending = this.kernels.get(path)
    if (!pending) return
    this.kernels.delete(path)
    const kernel = await pending.catch(() => undefined)
    if (!kernel) return
    this.host.log.info("notebook kernel stopping", { path })
    kernel.request?.reject(new Error("Kernel stopped; variables reset"))
    if (!kernel.exited) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000)
        kernel.handle.onExit(() => {
          clearTimeout(timer)
          resolve()
        })
        kernel.handle.kill("KILL")
      })
    }
    await rm(kernel.dir, { recursive: true, force: true })
  }

  async dispose() {
    this.disposed = true
    await Promise.all([...this.kernels.keys()].map((path) => this.stop(path)))
  }
}
