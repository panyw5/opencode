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
    entries.delete(key(this.entry.sessionID, this.entry.callID))
    notify(this.entry)
  }
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
    onChange: input.onChange,
  }
  const existing = entries.get(key(input.sessionID, input.callID))
  existing?.waiter?.resolve({ type: "abort" })
  entries.set(key(input.sessionID, input.callID), entry)
  return new AdvisorInterventionHandle(entry)
}

export function startAdvisorIntervention(input: { sessionID: SessionID; callID: string }): boolean {
  const entry = entries.get(key(input.sessionID, input.callID))
  if (!entry || entry.busy || entry.active) return false
  entry.active = true
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
