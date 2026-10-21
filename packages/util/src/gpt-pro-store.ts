import type { GptProAPI, GptProCommand, GptProJob } from "./gpt-pro"
import { gptProErrorText } from "./gpt-pro-error"
import {
  gptProArchivedResult,
  gptProExecutionSnapshot,
  gptProResultFinal,
  type GptProExecutionSnapshot,
  type GptProState,
  type GptProStateEvent,
  type GptProStateResponse,
} from "./gpt-pro-state"

export type GptProStateClient = Pick<GptProAPI, "command"> & Partial<Pick<GptProAPI, "state" | "list">>
export type GptProStateEntry = {
  state?: GptProState
  freshness: "loading" | "current" | "stale" | "unavailable"
  error?: string
  pending?: string
}
const mutations = new Set(["stop", "pause", "resume", "intervene", "background", "send"])

async function readWithDeadline<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Consultation state lookup timed out")), 10_000)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createGptProStateStore(client: GptProStateClient, log: (message: string) => void = () => {}) {
  const jobs = new Map<string, GptProExecutionSnapshot>()
  const records = new Map<string, GptProState>()
  const errors = new Map<string, string>()
  const requests = new Map<string, Promise<GptProStateEntry>>()
  const operations = new Map<string, string>()
  const retiredSources = new Set<string>()
  const watches = new Map<string, Set<() => void>>()
  const listWatches = new Set<() => void>()
  let sourceID: string | undefined
  let sequence = -1
  let generation = 0
  let connectionError = ""
  let stop: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let listing: Promise<void> | undefined
  let listedAt = 0
  let subscriptionGeneration = 0
  let legacySequence = 0
  let disposed = false

  const resolve = (id: string): GptProState | undefined => {
    const saved = records.get(id)
    if (saved?.kind === "archive") return saved
    let job = jobs.get(id) ?? (saved?.kind === "execution" ? jobs.get(saved.job.id) : undefined)
    if (!job) return saved
    const owner = job.owner
    const seen = new Set<string>()
    while (job.successorID) {
      if (seen.has(job.id)) return
      seen.add(job.id)
      const next = jobs.get(job.successorID)
      if (!next || next.owner !== owner) return
      job = next
    }
    return { kind: "execution", job }
  }
  const get = (id: string): GptProStateEntry => {
    const state = resolve(id)
    const error =
      connectionError || errors.get(id) || (!state && jobs.has(id) ? "Consultation chain could not be verified" : "")
    const resolvedID = state?.kind === "execution" ? state.job.id : id
    return {
      state,
      freshness: state ? (error ? "stale" : "current") : error ? "unavailable" : "loading",
      error: error || undefined,
      pending: operations.get(resolvedID),
    }
  }
  const emit = () => {
    const notify = (listener: () => void) => {
      try {
        listener()
      } catch {
        log("[gpt-pro-store] renderer listener failed; committed state retained")
      }
    }
    for (const listeners of watches.values()) for (const listener of listeners) notify(listener)
    for (const listener of listWatches) notify(listener)
  }
  const trim = () => {
    for (const id of records.keys()) {
      if (records.size <= 128) break
      if (watches.has(id)) continue
      records.delete(id)
      errors.delete(id)
    }
    for (const id of errors.keys()) {
      if (errors.size <= 256) break
      if (!watches.has(id) && !records.has(id)) errors.delete(id)
    }
  }
  const validate = (job: GptProExecutionSnapshot) => {
    const previous = jobs.get(job.id)
    if (previous && previous.owner !== job.owner) throw new Error("Consultation owner changed")
    if (previous && previous.stateVersion > job.stateVersion) {
      log(
        `[gpt-pro-store] older snapshot ignored id=${job.id} version=${job.stateVersion} current=${previous.stateVersion}`,
      )
      return false
    }
    if (previous && previous.stateVersion === job.stateVersion && JSON.stringify(previous) !== JSON.stringify(job))
      throw new Error("Conflicting consultation state version")
    return true
  }
  const failConnection = (error: unknown) => {
    connectionError = gptProErrorText(error) || "Consultation state connection unavailable"
    log(`[gpt-pro-store] connection stale source=${sourceID ?? "unknown"}`)
    emit()
  }
  const apply = (event: GptProStateEvent) => {
    if (event.type === "disconnected") {
      failConnection(event.message)
      return
    }
    if (retiredSources.has(event.sourceID)) return
    if (sourceID && event.sourceID !== sourceID && event.type !== "snapshot") {
      failConnection("Consultation state source changed; synchronizing")
      void refreshList()
      return
    }
    if (event.sourceID === sourceID && event.sequence < sequence) return
    if (event.type === "change" && sourceID && event.sequence > sequence + 1) {
      log(`[gpt-pro-store] event gap previous=${sequence} next=${event.sequence}`)
      failConnection("Consultation state stream requires synchronization")
      void refreshList()
      return
    }
    if (event.sourceID !== sourceID) {
      if (sourceID) retiredSources.add(sourceID)
      if (retiredSources.size > 16) retiredSources.delete(retiredSources.values().next().value!)
      sourceID = event.sourceID
      generation++
      jobs.clear()
      records.clear()
      errors.clear()
      requests.clear()
      sequence = -1
      log(`[gpt-pro-store] source initialized source=${sourceID}`)
    }
    // Validate the entire batch before changing any visible state.
    const accepted = event.jobs.filter(validate)
    if (event.type === "snapshot") {
      const retained = new Set(event.jobs.map((job) => job.id))
      for (const id of jobs.keys()) if (!retained.has(id)) jobs.delete(id)
    }
    for (const id of event.removed) jobs.delete(id)
    for (const job of accepted) jobs.set(job.id, job)
    sequence = event.sequence
    connectionError = ""
    for (const [id, previous] of records) {
      if (previous?.kind === "execution" && !jobs.has(id) && !jobs.has(previous.job.id)) {
        errors.set(id, "Execution record left the live state feed; checking the archive")
        if (watches.has(id)) void refresh(id)
      } else if (jobs.has(id) || resolve(id)?.kind === "execution") errors.delete(id)
    }
    emit()
  }
  const receive = (event: GptProStateEvent) => {
    if (disposed) return
    try {
      apply(event)
    } catch (error) {
      failConnection(error)
      void refreshList()
    }
  }
  async function refreshList() {
    if (listing) return listing
    const epoch = generation
    const startedSequence = sequence
    listing = (async () => {
      try {
        if (client.state) {
          const snapshot = await readWithDeadline(client.state.list())
          if (disposed) return
          if (epoch !== generation && sourceID !== snapshot.sourceID) return
          apply(snapshot)
        } else {
          if (!client.list) throw new Error("Consultation state API unavailable")
          const loaded = await readWithDeadline(client.list())
          if (disposed) return
          apply({
            type: "snapshot",
            sourceID: "legacy-local",
            sequence: ++legacySequence,
            jobs: loaded.map((job) => gptProExecutionSnapshot({ ...job, stateVersion: legacySequence })),
            removed: [],
          })
        }
        listedAt = Date.now()
      } catch (error) {
        if (epoch === generation && sequence === startedSequence) failConnection(error)
      }
    })().finally(() => {
      listing = undefined
    })
    return listing
  }
  async function refresh(id: string): Promise<GptProStateEntry> {
    if (disposed) return { freshness: "unavailable", error: "Consultation state store disposed" }
    const pending = requests.get(id)
    if (pending) return pending
    const epoch = generation
    const startingSource = sourceID
    const startedSequence = sequence
    log(`[gpt-pro-store] lookup started id=${id}`)
    const request = (async () => {
      try {
        let response: GptProStateResponse
        if (client.state) response = await readWithDeadline(client.state.read(id))
        else {
          await refreshList()
          const current = resolve(id)
          if (current?.kind === "execution" && !connectionError) {
            errors.delete(id)
            emit()
            return get(id)
          }
          const job = await readWithDeadline(client.command({ action: "status", id }))
          if (!gptProResultFinal(job.phase)) throw new Error("Legacy consultation state cannot be verified")
          response = {
            sourceID: sourceID ?? "legacy-local",
            sequence,
            requestedID: id,
            state: { kind: "archive", result: gptProArchivedResult(job) },
          }
        }
        if (disposed || (startingSource && epoch !== generation && sourceID !== response.sourceID)) return get(id)
        if (response.requestedID !== id) throw new Error("Consultation lookup identity mismatch")
        if (!sourceID) {
          sourceID = response.sourceID
          generation++
        }
        if (sourceID !== response.sourceID) {
          await refreshList()
          return get(id)
        }
        if (response.sequence < sequence && resolve(id)) return get(id)
        if (response.state.kind === "execution" && validate(response.state.job))
          jobs.set(response.state.job.id, response.state.job)
        records.set(id, response.state)
        errors.delete(id)
        trim()
        log(`[gpt-pro-store] lookup accepted id=${id} kind=${response.state.kind}`)
      } catch (error) {
        if ((epoch === generation || !startingSource) && !(sequence > startedSequence && resolve(id))) {
          errors.set(id, gptProErrorText(error))
          log(`[gpt-pro-store] lookup unavailable id=${id}; history not promoted`)
        }
      }
      emit()
      return get(id)
    })().finally(() => {
      if (requests.get(id) === request) requests.delete(id)
    })
    requests.set(id, request)
    return request
  }
  const connect = () => {
    const subscription = ++subscriptionGeneration
    stop?.()
    stop = client.state?.subscribe((event) => {
      if (subscription === subscriptionGeneration) receive(event)
    })
    void refreshList().then(() => {
      for (const id of watches.keys()) void refresh(id)
    })
  }
  const start = () => {
    if (timer) return
    connect()
    timer = setInterval(
      () => {
        if (connectionError) {
          connect()
          return
        }
        if (!client.state || Date.now() - listedAt >= 15_000) {
          void refreshList().then(() => {
            // Shared archives may advance in another profile; they never enter this controller's execution feed.
            for (const id of watches.keys()) if (resolve(id)?.kind === "archive") void refresh(id)
          })
        }
        for (const id of watches.keys()) {
          if (!resolve(id) || errors.has(id)) void refresh(id)
        }
      },
      client.state ? 3000 : 1000,
    )
    timer.unref?.()
  }
  const release = () => {
    if (watches.size || listWatches.size) return
    subscriptionGeneration++
    stop?.()
    stop = undefined
    if (timer) clearInterval(timer)
    timer = undefined
    for (const id of records.keys()) errors.set(id, "State subscription inactive; awaiting verification")
    trim()
  }
  return {
    get,
    refresh,
    refreshList,
    list: () => [...jobs.values()],
    connectionError: () => connectionError,
    watch(id: string, listener: () => void) {
      if (!timer && resolve(id)) errors.set(id, "Verifying cached consultation state")
      let listeners = watches.get(id)
      if (!listeners) watches.set(id, (listeners = new Set()))
      listeners.add(listener)
      start()
      listener()
      void refresh(id)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) watches.delete(id)
        release()
      }
    },
    watchList(listener: () => void) {
      listWatches.add(listener)
      start()
      listener()
      return () => {
        listWatches.delete(listener)
        release()
      }
    },
    async command(input: GptProCommand): Promise<GptProJob> {
      let operationID: string | undefined
      if (input.id && mutations.has(input.action ?? "")) {
        const entry = await refresh(input.id)
        if (entry.freshness !== "current" || entry.state?.kind !== "execution")
          throw new Error("Current consultation execution state could not be verified; no operation dispatched")
        operationID = entry.state.job.id
        if (operations.has(operationID))
          throw new Error("A consultation operation is already in progress; no operation dispatched")
        operations.set(operationID, input.action!)
        emit()
      }
      log(`[gpt-pro-store] command started action=${input.action ?? "consult"} id=${input.id ?? "new"}`)
      try {
        const job = await client.command(input)
        await refresh(input.id ?? job.id)
        return job
      } finally {
        if (operationID) {
          operations.delete(operationID)
          emit()
        }
      }
    },
    dispose() {
      disposed = true
      watches.clear()
      listWatches.clear()
      release()
      generation++
      jobs.clear()
      records.clear()
      errors.clear()
    },
  }
}

export type GptProStateStore = ReturnType<typeof createGptProStateStore>
