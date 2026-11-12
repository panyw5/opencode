import * as Log from "@opencode-ai/core/util/log"
import type { ExtensionHooks } from "@opencode-ai/extension-kit/server"
import type { SlotStore } from "./slot"

const log = Log.create({ service: "extension" })

type HookState = {
  slots: SlotStore
  assertAvailable(id: string): void
  mutationError(id: string): Error
  recordDisposalFailure(id: string, error: unknown): void
  withTimeout(promise: Promise<unknown>, timeoutMs: number | undefined): Promise<void>
  disposeTimeoutMs: number
}

/** No runtime import: the facade injects the ownership boundary explicitly. */
export function createHookOwner(state: HookState) {
  let hookDisposals = new WeakMap<ExtensionHooks, Promise<boolean>>()
  let hookFinalizers = new WeakMap<ExtensionHooks, () => unknown>()

  function finalizeHooks(id: string, hooks: ExtensionHooks, dispose: () => unknown) {
    const existing = hookDisposals.get(hooks)
    if (existing) return existing
    const disposal = state.slots.track(
      id,
      Promise.resolve()
        .then(dispose)
        .then(
          () => {
            state.slots.get(id).hooks.delete(hooks)
            return true
          },
          (error) => {
            state.recordDisposalFailure(id, error)
            log.error("extension instance dispose failed", { extension: id, error })
            throw error
          },
        ),
    )
    hookDisposals.set(hooks, disposal)
    return disposal
  }

  async function disposeHooks(id: string, hooks: ExtensionHooks | undefined) {
    if (!hooks) return
    try {
      await state.withTimeout(
        finalizeHooks(id, hooks, hookFinalizers.get(hooks) ?? (() => hooks.dispose?.())),
        state.disposeTimeoutMs,
      )
    } catch {
      // finalizeHooks records the failure; legacy callers remain best-effort.
    }
  }

  /** Calls retained by Plugin/ToolRegistry remain generation-bound, even after a
   * cache entry is invalidated. Track their actual work, not just server(). */
  function bindHook<T extends (...args: any[]) => any>(id: string, gen: number, fn: T, tool = false): T {
    return function (this: unknown, ...args: Parameters<T>) {
      state.assertAvailable(id)
      if (state.slots.get(id).generation !== gen) throw state.mutationError(id)
      let request: AbortController | undefined
      let requests: Set<AbortController> | undefined
      if (tool) {
        request = new AbortController()
        requests = state.slots.get(id).requests

        requests.add(request)
        const context = args[1]
        args[1] = {
          ...context,
          abort: context?.abort ? AbortSignal.any([context.abort, request.signal]) : request.signal,
        }
      }
      const cleanup = () => {
        if (!request || !requests) return
        requests.delete(request)
      }
      try {
        const result = fn.apply(this, args)
        if (result && typeof result.then === "function") {
          return state.slots.track(id, Promise.resolve(result).finally(cleanup))
        }
        cleanup()
        return result
      } catch (error) {
        cleanup()
        throw error
      }
    } as T
  }

  function bindHooks(id: string, gen: number, hooks: ExtensionHooks) {
    for (const key of Object.keys(hooks) as Array<keyof ExtensionHooks>) {
      const value = hooks[key]
      if (key !== "dispose" && typeof value === "function") {
        Object.assign(hooks, { [key]: bindHook(id, gen, value) })
      }
    }
    for (const definition of Object.values(hooks.tool ?? {})) {
      definition.execute = bindHook(id, gen, definition.execute, true)
    }
    if (hooks.auth?.loader) hooks.auth.loader = bindHook(id, gen, hooks.auth.loader)
    for (const method of hooks.auth?.methods ?? []) {
      if (method.authorize) method.authorize = bindHook(id, gen, method.authorize)
    }
    if (hooks.provider?.models) hooks.provider.models = bindHook(id, gen, hooks.provider.models)
  }

  return {
    finalizeHooks,
    disposeHooks,
    bindHooks,
    setFinalizer(hooks: ExtensionHooks, finalizer: () => unknown) {
      hookFinalizers.set(hooks, finalizer)
    },
    reset() {
      hookDisposals = new WeakMap()
      hookFinalizers = new WeakMap()
    },
  }
}
