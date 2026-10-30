import { randomUUID } from "node:crypto"
import type { GptProJob } from "@opencode-ai/util/gpt-pro"
import {
  gptProExecutionSnapshot,
  type GptProExecutionSnapshot,
  type GptProStateEvent,
} from "@opencode-ai/util/gpt-pro-state"

type Change = Extract<GptProStateEvent, { sourceID: string }>

/** Only durable commits enter the renderer feed; answer revision is unrelated. */
export class GptProStateFeed {
  readonly sourceID = randomUUID()
  private sequence = 0
  private committed = new Map<string, { fingerprint: string; job: GptProExecutionSnapshot }>()
  private listeners = new Set<(event: GptProStateEvent) => void>()
  constructor(private log: (message: string) => void) {}

  commit(jobs: GptProJob[], persist: () => void): Change | undefined {
    const versions = jobs.map((job) => job.stateVersion)
    const next = new Map<string, { fingerprint: string; job: GptProExecutionSnapshot }>()
    const changed: GptProExecutionSnapshot[] = []
    for (const job of jobs) {
      const fingerprint = JSON.stringify({ ...gptProExecutionSnapshot(job), stateVersion: 0 })
      const previous = this.committed.get(job.id)
      if (previous?.fingerprint !== fingerprint) {
        job.stateVersion = Math.max(job.stateVersion ?? 0, previous?.job.stateVersion ?? 0) + 1
        changed.push(gptProExecutionSnapshot(job))
      }
      next.set(job.id, { fingerprint, job: gptProExecutionSnapshot(job) })
    }
    const removed = [...this.committed.keys()].filter((id) => !next.has(id))
    try {
      persist()
    } catch (error) {
      jobs.forEach((job, index) => {
        job.stateVersion = versions[index]
      })
      this.log(`[gpt-pro-state] commit rejected source=${this.sourceID}; no state published`)
      throw error
    }
    this.committed = next
    if (!changed.length && !removed.length) return
    return { type: "change", sourceID: this.sourceID, sequence: ++this.sequence, jobs: changed, removed }
  }

  publish(event: Change | undefined) {
    if (!event) return
    this.log(
      `[gpt-pro-state] committed source=${this.sourceID} sequence=${event.sequence} changed=${event.jobs.length} removed=${event.removed.length}`,
    )
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        this.log(`[gpt-pro-state] subscriber failed source=${this.sourceID}`)
      }
    }
  }

  list(): Change {
    return {
      type: "snapshot",
      sourceID: this.sourceID,
      sequence: this.sequence,
      jobs: [...this.committed.values()].map((x) => x.job),
      removed: [],
    }
  }

  get(id: string) {
    return this.committed.get(id)?.job
  }
  subscribe(listener: (event: GptProStateEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  unavailable() {
    for (const listener of this.listeners) {
      try {
        listener({
          type: "disconnected",
          message:
            "result_storage: Execution persistence failed. Restore storage and explicitly recover; no new send is authorized.",
        })
      } catch {}
    }
  }
  dispose() {
    for (const listener of this.listeners) {
      try {
        listener({ type: "disconnected", message: "Consultation controller stopped" })
      } catch {}
    }
    this.listeners.clear()
  }
}
