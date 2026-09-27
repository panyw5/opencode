import { createRoot, getOwner, runWithOwner, type Owner } from "solid-js"
import type { FileViewerProps } from "@opencode-ai/ui/file-viewer-registry"
import { makeExtensionContext, type FileViewerContribution, type WebExtensionContext } from "./context"
import type { Disposable, ExtensionInfo } from "./types"

export type WebExtensionModule = {
  default?: {
    id?: unknown
    apiVersion?: unknown
    activate?: unknown
  }
}

export type ActivationDeps = {
  hostOwner: Owner
  importModule(url: string): Promise<WebExtensionModule>
  addStyle(url: string, extensionID: string): Promise<() => void>
  registerViewer(manifest: ExtensionInfo, contribution: FileViewerContribution): () => void
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
    if (!web) throw new Error(`Extension has no web entry: ${runtime.manifest.id}`)
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
    if (!extension || extension.id !== runtime.manifest.id || extension.apiVersion !== 1 || typeof extension.activate !== "function") {
      throw new Error(`Extension module has an invalid default export: ${runtime.manifest.id}`)
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
          })
          Promise.resolve()
            .then(() => {
              if (!valid()) return
              return (extension.activate as (context: WebExtensionContext) => unknown)(context)
            })
            .then(
              async (cleanup) => {
                if (typeof cleanup === "function") {
                  if (valid()) runtime.cleanup = cleanup as () => void | Promise<void>
                  else await Promise.resolve((cleanup as () => void | Promise<void>)()).catch(() => undefined)
                }
                resolve()
              },
              reject,
            )
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

export function addExtensionStyle(url: string, extensionID: string) {
  return new Promise<() => void>((resolve) => {
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = url
    link.dataset.extension = extensionID
    link.addEventListener("load", () => resolve(() => link.remove()), { once: true })
    link.addEventListener("error", () => resolve(() => link.remove()), { once: true })
    document.head.append(link)
  })
}
