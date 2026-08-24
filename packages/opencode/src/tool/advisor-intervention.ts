import type { SessionID } from "@/session/schema"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.advisor_intervention" })

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
    log.info("advisor intervention busy state changed", {
      sessionID: this.entry.sessionID,
      callID: this.entry.callID,
      advisor: this.entry.advisor,
      busy,
    })
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
    log.info("closing advisor intervention", {
      sessionID: this.entry.sessionID,
      callID: this.entry.callID,
      advisor: this.entry.advisor,
      active: this.entry.active,
    })
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
  if (existing) {
    existing.waiter?.resolve({ type: "abort" })
  }
  entries.set(key(input.sessionID, input.callID), entry)
  log.info("registered advisor intervention", {
    sessionID: input.sessionID,
    callID: input.callID,
    advisor: input.advisor,
    replaced: existing !== undefined,
  })
  return new AdvisorInterventionHandle(entry)
}

export function startAdvisorIntervention(input: { sessionID: SessionID; callID: string }): boolean {
  const entry = entries.get(key(input.sessionID, input.callID))
  if (!entry || entry.busy) {
    log.info("advisor intervention start rejected", {
      sessionID: input.sessionID,
      callID: input.callID,
      reason: !entry ? "not_found" : "busy",
    })
    return false
  }
  if (entry.active) {
    // Idempotent: UI may retry start while the intervention loop is already active.
    log.info("advisor intervention already active", {
      sessionID: input.sessionID,
      callID: input.callID,
      advisor: entry.advisor,
    })
    notify(entry)
    return true
  }
  entry.active = true
  log.info("advisor intervention started", {
    sessionID: input.sessionID,
    callID: input.callID,
    advisor: entry.advisor,
  })
  notify(entry)
  return true
}

export function sendAdvisorIntervention(input: { sessionID: SessionID; callID: string; message: string }): boolean {
  const entry = entries.get(key(input.sessionID, input.callID))
  const message = input.message.trim()
  if (!entry || !entry.active || entry.busy || entry.queued || !message) {
    log.info("advisor intervention message rejected", {
      sessionID: input.sessionID,
      callID: input.callID,
      reason: !entry
        ? "not_found"
        : !entry.active
          ? "inactive"
          : entry.busy
            ? "busy"
            : entry.queued
              ? "queued"
              : "empty",
    })
    return false
  }
  const command = { type: "message" as const, message }
  const deliveredToWaiter = entry.waitingForInput
  if (deliveredToWaiter) resolveWaiter(entry, command)
  else entry.queued = command
  log.info("advisor intervention message accepted", {
    sessionID: input.sessionID,
    callID: input.callID,
    advisor: entry.advisor,
    deliveredToWaiter,
  })
  notify(entry)
  return true
}

export function finishAdvisorIntervention(input: { sessionID: SessionID; callID: string }): boolean {
  const entry = entries.get(key(input.sessionID, input.callID))
  if (!entry || !entry.active) {
    log.info("advisor intervention finish rejected", {
      sessionID: input.sessionID,
      callID: input.callID,
      reason: !entry ? "not_found" : "inactive",
    })
    return false
  }
  entry.active = false
  entry.queued = undefined
  resolveWaiter(entry, { type: "finish" })
  log.info("advisor intervention finished", {
    sessionID: input.sessionID,
    callID: input.callID,
    advisor: entry.advisor,
  })
  notify(entry)
  return true
}
