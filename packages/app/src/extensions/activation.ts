import { createRoot, getOwner, runWithOwner, type Owner } from "solid-js"
import type { FileViewerProps } from "@opencode-ai/ui/file-viewer-registry"
import {
  makeExtensionContext,
  type CommandContribution,
  type FileViewerContribution,
  type PanelContribution,
  type ToolRendererContribution,
  type WebExtensionContext,
} from "./context"
import type { Disposable, ExtensionInfo } from "./types"
import type { ExtensionHostModules } from "./modules"

export type WebExtensionModule = {
  default?: {
    id?: unknown
    apiVersion?: unknown
    activate?: unknown
  }
  // Build metadata emitted by extension-kit (T4.6):
  // `export const __opencodeBuild = { solid: "x.y.z" }`.
  __opencodeBuild?: unknown
}

export type SolidVersionDrift = "match" | "minor" | "major" | "unknown"

function majorMinor(version: string) {
  const match = /^\s*(\d+)\.(\d+)/.exec(version)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]) }
}

// Compares the host's shared solid-js version against the version an extension
// was built against. "unknown" covers unparseable input and is skipped like a
// missing field so older artifacts stay compatible.
export function compareSolidVersions(host: string, built: string): SolidVersionDrift {
  const a = majorMinor(host)
  const b = majorMinor(built)
  if (!a || !b) return "unknown"
  if (a.major !== b.major) return "major"
  if (a.minor !== b.minor) return "minor"
  return "match"
}

// Reads the declared build-time solid-js version from an extension artifact.
// Missing or malformed metadata returns undefined and the check is skipped.
function declaredSolidVersion(module: WebExtensionModule) {
  const build = module.__opencodeBuild
  if (!build || typeof build !== "object") return undefined
  const solid = (build as { solid?: unknown }).solid
  return typeof solid === "string" ? solid : undefined
}

export type ActivationDeps = {
  hostOwner: Owner
  importModule(url: string): Promise<WebExtensionModule>
  addStyle(url: string, extensionID: string): Promise<() => void>
  registerViewer(manifest: ExtensionInfo, contribution: FileViewerContribution): () => void
  registerToolRenderer(manifest: ExtensionInfo, contribution: ToolRendererContribution): () => void
  registerPanel(manifest: ExtensionInfo, contribution: PanelContribution): () => void
  registerCommand(manifest: ExtensionInfo, contribution: CommandContribution): () => void
  // Server bridge. The host owns transport/auth/events; the manager only
  // forwards per-extension calls keyed by the activated manifest.
  callRpc(
    manifest: ExtensionInfo,
    input: { method: string; input?: unknown; directory?: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>
  listenEvents(
    manifest: ExtensionInfo,
    name: string,
    listener: (data: unknown, meta: { directory?: string }) => void,
  ): () => void
  readSetting(manifest: ExtensionInfo, key: string): unknown
  updateSettings(manifest: ExtensionInfo, patch: Record<string, unknown>): Promise<void>
  timeoutMs?: number
}

type Runtime = {
  generation: number
  manifest: ExtensionInfo
  promise?: Promise<void>
  cleanup?: () => void | Promise<void>
  rootDispose?: () => void
  subscriptions: Disposable[]
  styles: Array<() => void>
}

export class ExtensionActivationManager {
  private runtimes = new Map<string, Runtime>()
  private epochs = new Map<string, number>()

  constructor(private deps: ActivationDeps) {}

  private next(id: string) {
    const value = (this.epochs.get(id) ?? 0) + 1
    this.epochs.set(id, value)
    return value
  }

  get(id: string) {
    return this.runtimes.get(id)
  }

  active(id: string) {
    const runtime = this.runtimes.get(id)
    return !!runtime && !runtime.promise
  }

  async activate(manifest: ExtensionInfo) {
    const existing = this.runtimes.get(manifest.id)
    if (existing?.promise) return existing.promise
    if (existing) return
    const generation = this.next(manifest.id)
    const runtime: Runtime = { generation, manifest, subscriptions: [], styles: [] }
    this.runtimes.set(manifest.id, runtime)
    const task = withTimeout(
      this.activateOne(runtime),
      this.deps.timeoutMs ?? 10_000,
      `Extension activation timed out: ${manifest.id}`,
    )
    runtime.promise = task
    try {
      await task
    } catch (error) {
      if (this.runtimes.get(manifest.id) === runtime) {
        this.runtimes.delete(manifest.id)
        this.next(manifest.id)
        await this.disposeRuntime(runtime)
      }
      throw error
    } finally {
      if (this.runtimes.get(manifest.id) === runtime) runtime.promise = undefined
    }
  }

  private async activateOne(runtime: Runtime) {
    const web = runtime.manifest.web
    if (!web?.entry) throw new Error(`Extension has no web entry: ${runtime.manifest.id}`)
    const valid = () => this.runtimes.get(runtime.manifest.id)?.generation === runtime.generation
    const base = new URL(web.base)
    if (base.origin === "null") throw new Error(`Extension has an invalid web origin: ${runtime.manifest.id}`)

    for (const style of web.styles) {
      const url = new URL(style, base)
      if (url.origin !== base.origin) throw new Error(`Extension style origin mismatch: ${runtime.manifest.id}`)
      const remove = await this.deps.addStyle(url.href, runtime.manifest.id)
      if (!valid()) {
        remove()
        return
      }
      runtime.styles.push(remove)
    }

    const entry = new URL(web.entry, base)
    if (entry.origin !== base.origin) throw new Error(`Extension entry origin mismatch: ${runtime.manifest.id}`)
    const module = await this.deps.importModule(entry.href)
    if (!valid()) return
    const extension = module.default
    if (
      !extension ||
      extension.id !== runtime.manifest.id ||
      extension.apiVersion !== 1 ||
      typeof extension.activate !== "function"
    ) {
      throw new Error(`Extension module has an invalid default export: ${runtime.manifest.id}`)
    }

    // Version guard: extensions are compiled against the host's shared
    // solid-js. A major drift is incompatible and rejects activation; a minor
    // drift is tolerated with a warning. Artifacts without build metadata skip
    // the check entirely.
    const built = declaredSolidVersion(module)
    const installed = (globalThis as typeof globalThis & { __OPENCODE_EXTENSION_HOST__?: ExtensionHostModules })
      .__OPENCODE_EXTENSION_HOST__
    const hostSolid = installed?.versions?.["solid-js"]
    if (built && typeof hostSolid === "string") {
      const drift = compareSolidVersions(hostSolid, built)
      if (drift === "major") {
        throw new Error(
          `Extension built against incompatible solid-js: ${runtime.manifest.id} (built=${built} host=${hostSolid})`,
        )
      }
      if (drift === "minor") {
        console.warn(
          `[extension-host] solid-js minor mismatch id=${runtime.manifest.id} built=${built} host=${hostSolid}`,
        )
      }
    }

    await new Promise<void>((resolve, reject) => {
      runWithOwner(this.deps.hostOwner, () => {
        createRoot((dispose) => {
          runtime.rootDispose = dispose
          const extensionOwner = getOwner()
          if (!extensionOwner) {
            reject(new Error(`Extension owner is unavailable: ${runtime.manifest.id}`))
            return
          }
          const context = makeExtensionContext({
            manifest: runtime.manifest,
            owner: extensionOwner,
            valid,
            subscriptions: runtime.subscriptions,
            registerViewer: (contribution) => this.deps.registerViewer(runtime.manifest, contribution),
            registerToolRenderer: (contribution) => this.deps.registerToolRenderer(runtime.manifest, contribution),
            registerPanel: (contribution) => this.deps.registerPanel(runtime.manifest, contribution),
            registerCommand: (contribution) => this.deps.registerCommand(runtime.manifest, contribution),
            callRpc: (input) => this.deps.callRpc(runtime.manifest, input),
            listenEvents: (name, listener) => this.deps.listenEvents(runtime.manifest, name, listener),
            readSetting: (key) => this.deps.readSetting(runtime.manifest, key),
            updateSettings: (patch) => this.deps.updateSettings(runtime.manifest, patch),
          })
          Promise.resolve()
            .then(() => {
              if (!valid()) return
              return (extension.activate as (context: WebExtensionContext) => unknown)(context)
            })
            .then(async (cleanup) => {
              if (typeof cleanup === "function") {
                if (valid()) runtime.cleanup = cleanup as () => void | Promise<void>
                else await Promise.resolve((cleanup as () => void | Promise<void>)()).catch(() => undefined)
              }
              resolve()
            }, reject)
        })
      })
    })
    if (!valid()) await this.disposeRuntime(runtime)
  }

  async deactivate(id: string) {
    this.next(id)
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    this.runtimes.delete(id)
    await this.disposeRuntime(runtime)
  }

  async disposeAll() {
    await Promise.all([...this.runtimes.keys()].map((id) => this.deactivate(id)))
  }

  private async disposeRuntime(runtime: Runtime) {
    try {
      await Promise.resolve(runtime.cleanup?.())
    } catch (error) {
      console.warn(
        `[extension-host] cleanup failed id=${runtime.manifest.id} error=${error instanceof Error ? error.message : String(error)}`,
      )
    }
    runtime.cleanup = undefined
    for (const item of runtime.subscriptions.toReversed()) {
      try {
        item.dispose()
      } catch (error) {
        console.warn(
          `[extension-host] subscription dispose failed id=${runtime.manifest.id} error=${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    runtime.subscriptions.length = 0
    try {
      runtime.rootDispose?.()
    } catch (error) {
      console.warn(
        `[extension-host] root dispose failed id=${runtime.manifest.id} error=${error instanceof Error ? error.message : String(error)}`,
      )
    }
    runtime.rootDispose = undefined
    for (const remove of runtime.styles.toReversed()) {
      try {
        remove()
      } catch (error) {
        console.warn(
          `[extension-host] style dispose failed id=${runtime.manifest.id} error=${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    runtime.styles.length = 0
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function importExtensionModule(url: string): Promise<WebExtensionModule> {
  return import(/* @vite-ignore */ url)
}

export class ExtensionStyleLoadError extends Error {
  constructor(extensionID: string, asset: string, reason: string) {
    super(`Extension stylesheet ${reason}: ${extensionID} (${asset})`)
    this.name = "ExtensionStyleLoadError"
  }
}

export async function activateWithStyleRecovery(input: {
  id: string
  current(): ExtensionInfo | undefined
  available(): boolean
  activate(manifest: ExtensionInfo): Promise<void>
  refresh(): Promise<void>
}): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const manifest = input.current()
    if (!input.available() || !manifest?.enabled || manifest.state !== "ready" || !manifest.web?.entry) return false
    try {
      await input.activate(manifest)
      return input.available()
    } catch (error) {
      if (!(error instanceof ExtensionStyleLoadError) || attempt > 0 || !input.available()) throw error
      // A linked extension rebuild invalidates its old fingerprinted URLs.
      // Re-read the manifest before retrying instead of reusing the stale URL.
      console.warn(`[extension-host] stylesheet activation retry id=${input.id} refresh=required`)
      await input.refresh()
    }
  }
  return false
}

export function addExtensionStyle(url: string, extensionID: string, options: { timeoutMs?: number } = {}) {
  return new Promise<() => void>((resolve, reject) => {
    const link = document.createElement("link")
    const asset = new URL(url, document.baseURI).pathname.split("/").at(-1) ?? "stylesheet"
    link.rel = "stylesheet"
    link.href = url
    link.dataset.extension = extensionID
    let settled = false
    let removed = false
    const remove = () => {
      if (removed) return
      removed = true
      link.remove()
      console.debug(`[extension-host] stylesheet removed id=${extensionID} asset=${asset}`)
    }
    const cleanup = () => {
      clearTimeout(timer)
      link.removeEventListener("load", loaded)
      link.removeEventListener("error", failed)
    }
    const fail = (reason: string) => {
      if (settled) return
      settled = true
      cleanup()
      remove()
      console.warn(`[extension-host] stylesheet failed id=${extensionID} asset=${asset} reason=${reason}`)
      reject(new ExtensionStyleLoadError(extensionID, asset, reason))
    }
    const loaded = () => {
      if (settled) return
      settled = true
      cleanup()
      console.debug(`[extension-host] stylesheet loaded id=${extensionID} asset=${asset}`)
      resolve(remove)
    }
    const failed = () => fail("failed to load")
    const timer = setTimeout(() => fail("timed out"), options.timeoutMs ?? 4_000)
    link.addEventListener("load", loaded, { once: true })
    link.addEventListener("error", failed, { once: true })
    console.debug(`[extension-host] stylesheet loading id=${extensionID} asset=${asset}`)
    document.head.append(link)
  })
}
