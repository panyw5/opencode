import type { SessionID } from "@/session/schema"

export type AdvisorKind = "codex" | "claude" | "grok" | "dsh"

export type AdvisorInterventionSnapshot = {
  available: true
  active: boolean
  waitingForInput: boolean
  busy: boolean
  queued: boolean
  advisor: AdvisorKind
  callID: string
}

type Command = { type: "message"; message: string } | { type: "finish" } | { type: "abort" }

type Entry = {
  sessionID: SessionID
  callID: string
  advisor: AdvisorKind
  active: boolean
  busy: boolean
  waitingForInput: boolean
  queued?: Command
  waiter?: {
    resolve: (command: Command) => void
    reject: (error: unknown) => void
  }
  activationWaiters: Array<{
    resolve: (result: "active" | "abort") => void
  }>
  onChange?: () => void
}

const entries = new Map<string, Entry>()

function key(sessionID: SessionID, callID: string): string {
  return `${sessionID}:${callID}`
}

function notify(entry: Entry): void {
  entry.onChange?.()
}

function resolveWaiter(entry: Entry, command: Command): void {
  const waiter = entry.waiter
  entry.waiter = undefined
  entry.waitingForInput = false
  waiter?.resolve(command)
}

function resolveActivationWaiters(entry: Entry, result: "active" | "abort"): void {
  const waiters = entry.activationWaiters.splice(0, entry.activationWaiters.length)
  for (const waiter of waiters) waiter.resolve(result)
}

function takeQueued(entry: Entry): Command | undefined {
  const command = entry.queued
  entry.queued = undefined
  return command
}

export class AdvisorInterventionHandle {
  constructor(private readonly entry: Entry) {}

  snapshot(): AdvisorInterventionSnapshot {
    return {
      available: true,
      active: this.entry.active,
      waitingForInput: this.entry.waitingForInput,
      busy: this.entry.busy,
      queued: this.entry.queued !== undefined,
      advisor: this.entry.advisor,
      callID: this.entry.callID,
    }
  }

  isActive(): boolean {
    return this.entry.active
  }

  setBusy(busy: boolean): void {
    this.entry.busy = busy
    notify(this.entry)
  }

  /**
   * After the first advisor answer, hold the tool open until the user starts
   * intervention, the session aborts, or the idle timeout elapses.
   */
  waitForStart(signal: AbortSignal, timeoutMs: number): Promise<"active" | "timeout" | "abort"> {
    if (this.entry.active) return Promise.resolve("active")
    if (signal.aborted) return Promise.resolve("abort")

    return new Promise<"active" | "timeout" | "abort">((resolve) => {
      let settled = false
      const settle = (result: "active" | "timeout" | "abort") => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        const index = this.entry.activationWaiters.findIndex((item) => item.resolve === onActive)
        if (index >= 0) this.entry.activationWaiters.splice(index, 1)
        resolve(result)
      }

      const onActive = (result: "active" | "abort") => settle(result === "active" ? "active" : "abort")
      const onAbort = () => settle("abort")
      const timer = setTimeout(() => settle("timeout"), Math.max(1_000, timeoutMs))

      this.entry.activationWaiters.push({ resolve: onActive })
      signal.addEventListener("abort", onAbort, { once: true })
      notify(this.entry)
    })
  }

  waitForInput(signal: AbortSignal): Promise<Command> {
    if (!this.entry.active) return Promise.resolve({ type: "finish" })
    if (this.entry.waiter) return Promise.reject(new Error("Advisor intervention is already waiting for input"))

    const queued = takeQueued(this.entry)
    if (queued) {
      notify(this.entry)
      return Promise.resolve(queued)
    }

    this.entry.waitingForInput = true
    notify(this.entry)

    return new Promise<Command>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort)
        if (this.entry.waiter?.resolve === resolve) {
          this.entry.waiter = undefined
          this.entry.waitingForInput = false
        }
        resolve({ type: "abort" })
      }
      signal.addEventListener("abort", onAbort, { once: true })
      this.entry.waiter = {
        resolve: (command) => {
          signal.removeEventListener("abort", onAbort)
          resolve(command)
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort)
          reject(error)
        },
      }
    })
  }

  async wait(signal: AbortSignal): Promise<Command> {
    return this.waitForInput(signal)
  }

  submit(message: string): boolean {
    const text = message.trim()
    if (!this.entry.active || this.entry.busy || this.entry.queued || !text) return false
    const command = { type: "message" as const, message: text }
    if (this.entry.waitingForInput) resolveWaiter(this.entry, command)
    else this.entry.queued = command
    notify(this.entry)
    return true
  }

  finish(): boolean {
    if (!this.entry.active) return false
    this.entry.active = false
    this.entry.queued = undefined
    resolveWaiter(this.entry, { type: "finish" })
    notify(this.entry)
    return true
  }

  close(): void {
    this.entry.active = false
    resolveWaiter(this.entry, { type: "abort" })
    resolveActivationWaiters(this.entry, "abort")
    entries.delete(key(this.entry.sessionID, this.entry.callID))
    notify(this.entry)
  }
}

/** How long a finished advisor turn stays open for the user to press Intervene. */
export const INTERVENTION_HOLD_MS = 5 * 60 * 1000

/**
 * Keep the tool call alive after the first answer until the user starts
 * intervention, aborts, or the hold window expires.
 * @returns true when intervention is active and the tool should enter the message loop.
 */
export async function holdForIntervention(
  handle: AdvisorInterventionHandle | undefined,
  signal: AbortSignal,
  timeoutMs: number = INTERVENTION_HOLD_MS,
): Promise<boolean> {
  if (!handle) return false
  if (handle.isActive()) return true
  const result = await handle.waitForStart(signal, timeoutMs)
  return result === "active"
}

export function registerAdvisorIntervention(input: {
  sessionID: SessionID
  callID: string
  advisor: AdvisorKind
  onChange?: () => void
}): AdvisorInterventionHandle {
  const entry: Entry = {
    sessionID: input.sessionID,
    callID: input.callID,
    advisor: input.advisor,
    active: false,
    busy: false,
    waitingForInput: false,
    activationWaiters: [],
    onChange: input.onChange,
  }
  const existing = entries.get(key(input.sessionID, input.callID))
  if (existing) {
    existing.waiter?.resolve({ type: "abort" })
    resolveActivationWaiters(existing, "abort")
  }
  entries.set(key(input.sessionID, input.callID), entry)
  return new AdvisorInterventionHandle(entry)
}

export function startAdvisorIntervention(input: { sessionID: SessionID; callID: string }): boolean {
  const entry = entries.get(key(input.sessionID, input.callID))
  if (!entry || entry.busy) return false
  if (entry.active) {
    // Idempotent: UI may retry start while the hold loop is already active.
    notify(entry)
    return true
  }
  entry.active = true
  resolveActivationWaiters(entry, "active")
  notify(entry)
  return true
}

export function sendAdvisorIntervention(input: { sessionID: SessionID; callID: string; message: string }): boolean {
  const entry = entries.get(key(input.sessionID, input.callID))
  const message = input.message.trim()
  if (!entry || !entry.active || entry.busy || entry.queued || !message) return false
  const command = { type: "message" as const, message }
  if (entry.waitingForInput) resolveWaiter(entry, command)
  else entry.queued = command
  notify(entry)
  return true
}

export function finishAdvisorIntervention(input: { sessionID: SessionID; callID: string }): boolean {
  const entry = entries.get(key(input.sessionID, input.callID))
  if (!entry || !entry.active) return false
  entry.active = false
  entry.queued = undefined
  resolveWaiter(entry, { type: "finish" })
  notify(entry)
  return true
}
