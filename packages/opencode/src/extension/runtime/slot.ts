import * as Log from "@opencode-ai/core/util/log"
import type { ExtensionHooks, ExtensionService, ServerExtension } from "@opencode-ai/extension-kit/server"
import type { Loaded } from "../manifest"

const log = Log.create({ service: "extension" })

type SettingsListener = (next: Record<string, unknown>) => void

export type Entry = {
  id: string
  status: "loading" | "ready" | "error"
  error?: string
  manifest?: Loaded
  module?: ServerExtension
  fingerprint?: string
  source?: string
  service?: ExtensionService
  activating?: Promise<ExtensionService | undefined>
  settings: Record<string, unknown>
  settingsListeners: Set<SettingsListener>
  serverUrl?: URL
  instances: Map<string, ExtensionHooks>
  requests: Set<AbortController>
  resources: Set<() => void>
}

export function emptyEntry(id: string, settings: Record<string, unknown>): Entry {
  return {
    id,
    status: "loading",
    settings,
    settingsListeners: new Set(),
    instances: new Map(),
    requests: new Set(),
    resources: new Set(),
  }
}

/** Process-owned facts are deliberately orthogonal: blocked never clears when
 * a fence is released, and quiesce never steals the installer's fence. */
export type Slot = {
  readonly id: string
  generation: number
  epoch: number
  entry?: Entry
  loading?: Promise<Entry | undefined>
  fenced: boolean
  quiescing: boolean
  blocked: boolean
  pending: Set<Promise<unknown>>
  requests: Set<AbortController>
  hooks: Set<ExtensionHooks>
  failedDisposal: boolean
  error?: string
  version?: string
  failure?: {
    phase: "import" | "activate" | "dispose" | "quiesce" | "server" | "timeout" | "timer"
    message: string
    at: number
  }
  transientError?: { phase: "server" | "timer"; message: string; at: number }
}

export function phaseOf(slot: Slot) {
  if (slot.blocked) return "blocked"
  if (slot.quiescing) return "quiescing"
  if (slot.fenced) return "mutating"
  return slot.entry?.status ?? (slot.loading ? "loading" : "idle")
}

type Transition =
  | { type: "invalidate" }
  | { type: "mutation.begin" }
  | { type: "mutation.release" }
  | { type: "quiesce.begin" }
  | { type: "quiesce.end" }
  | { type: "blocked"; error?: string }
  | { type: "disposal.failed"; error: string }
  | { type: "entry.set"; entry: Entry }
  | { type: "activate.ready"; entry: Entry; service: ExtensionService }
  | { type: "entry.error"; entry: Entry; phase: "import" | "activate" | "timeout"; error: string }
  | { type: "runtime.error"; phase: "server" | "timer"; error: string }
  | { type: "server.ready" }
  | { type: "entry.drop" }
  | { type: "load.set"; loading: Promise<Entry | undefined> }
  | { type: "load.drop"; expected?: Promise<Entry | undefined> }

export class SlotStore {
  private readonly slots = new Map<string, Slot>()

  get(id: string): Slot {
    let slot = this.slots.get(id)
    if (!slot) {
      slot = {
        id,
        generation: 0,
        epoch: 0,
        fenced: false,
        quiescing: false,
        blocked: false,
        pending: new Set(),
        requests: new Set(),
        hooks: new Set(),
        failedDisposal: false,
      }
      this.slots.set(id, slot)
    }
    return slot
  }

  values() {
    return this.slots.values()
  }

  epochs() {
    return new Map([...this.slots.values()].map((slot) => [slot.id, slot.epoch]))
  }

  gated(id: string) {
    const slot = this.get(id)
    return slot.fenced || slot.quiescing || slot.blocked
  }

  transition(id: string, event: Transition) {
    const started = Date.now()
    const slot = this.get(id)
    switch (event.type) {
      case "invalidate":
        slot.generation++
        break
      case "mutation.begin":
        if (this.gated(id)) throw new Error(`Invalid extension transition: ${id} mutation.begin`)
        slot.fenced = true
        slot.generation++
        slot.epoch++
        break
      case "mutation.release":
        slot.fenced = false
        break
      case "quiesce.begin":
        if (slot.quiescing) throw new Error(`Invalid extension transition: ${id} quiesce.begin`)
        slot.quiescing = true
        slot.epoch++
        slot.generation++
        break
      case "quiesce.end":
        slot.quiescing = false
        break
      case "blocked":
        slot.blocked = true
        slot.error ??= event.error
        slot.failure ??= {
          phase: "quiesce",
          message: slot.error ?? "Extension cleanup did not complete",
          at: Date.now(),
        }
        break
      case "disposal.failed":
        slot.failedDisposal = true
        slot.error = event.error
        slot.failure = { phase: "dispose", message: event.error, at: Date.now() }
        break
      case "activate.ready":
        if (slot.entry !== event.entry || this.gated(id))
          throw new Error(`Invalid extension transition: ${id} activate.ready`)
        event.entry.service = event.service
        event.entry.status = "ready"
        break
      case "entry.error":
        event.entry.status = "error"
        event.entry.error = event.error
        slot.failure = { phase: event.phase, message: event.error, at: Date.now() }
        break
      case "entry.set":
        slot.entry = event.entry
        break
      case "runtime.error":
        slot.transientError = { phase: event.phase, message: event.error, at: Date.now() }
        slot.failure = slot.transientError
        break
      case "server.ready":
        if (slot.transientError?.phase === "server") slot.transientError = undefined
        break
      case "entry.drop":
        slot.entry = undefined
        slot.transientError = undefined
        break
      case "load.set":
        slot.loading = event.loading
        break
      case "load.drop":
        if (!event.expected || slot.loading === event.expected) slot.loading = undefined
        break
    }
    log.debug("extension runtime transition", {
      extension: id,
      phase: event.type,
      runtime: phaseOf(slot),
      gen: slot.generation,
      epoch: slot.epoch,
      elapsedMs: Date.now() - started,
      fenced: slot.fenced,
      quiescing: slot.quiescing,
      blocked: slot.blocked,
    })
    return slot
  }

  track<T>(id: string, promise: Promise<T>): Promise<T> {
    const slot = this.get(id)
    slot.pending.add(promise)
    const settled = () => slot.pending.delete(promise)
    void promise.then(settled, settled)
    return promise
  }

  canReleasePins() {
    return [...this.slots.values()].every(
      (slot) => !slot.pending.size && !slot.requests.size && !slot.hooks.size && !slot.failedDisposal,
    )
  }

  reset() {
    // Preserve monotonic generations exactly as the runtime's former reset did:
    // late work from a previous test cannot publish into a newer test entry.
    for (const [id, slot] of [...this.slots]) {
      const generation = slot.generation
      this.slots.delete(id)
      this.get(id).generation = generation
    }
  }
}
