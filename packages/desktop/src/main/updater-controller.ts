export type UpdaterState =
  | { status: "disabled" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "paused"; version: string; percent?: number }
  | { status: "ready"; version: string }
  | { status: "up-to-date" }
  | { status: "installing"; version: string }
  | { status: "error"; message: string }

export type UpdaterReadyRecord = { version: string }

export type UpdaterBackend = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>
  downloadUpdate(onProgress?: (percent: number) => void): Promise<unknown>
  cancelDownload?(): void
  quitAndInstall(): void
}

type UpdaterPersistence = {
  get(): UpdaterReadyRecord | undefined | Promise<UpdaterReadyRecord | undefined>
  set(value: UpdaterReadyRecord): void | Promise<void>
  clear(): void | Promise<void>
}

export function createUpdaterController(input: {
  enabled: boolean
  currentVersion: string
  backend: UpdaterBackend
  persistence: UpdaterPersistence
  stop: () => Promise<void>
  log?: (message: string, data?: object) => void
}) {
  let state: UpdaterState = input.enabled ? { status: "idle" } : { status: "disabled" }
  let pending: Promise<UpdaterState> | undefined
  let generation = 0
  const listeners = new Set<(state: UpdaterState) => void>()

  const transition = (next: UpdaterState) => {
    input.log?.(`updater state changed from=${state.status} to=${next.status}`)
    state = next
    listeners.forEach((listener) => listener(state))
    return state
  }

  const run = (work: (id: number) => Promise<UpdaterState>) => {
    const id = ++generation
    const task = Promise.resolve()
      .then(() => work(id))
      .catch((error) => {
        if (id !== generation) {
          input.log?.(`updater interrupted operation settled generation=${id}`)
          return state
        }
        const message = error instanceof Error ? error.message : String(error)
        input.log?.(`updater check failed message=${message}`)
        return transition({ status: "error", message })
      })
      .finally(() => {
        if (pending === task) pending = undefined
      })
    pending = task
    return task
  }

  const download = async (version: string, id: number) => {
    transition({ status: "downloading", version, percent: 0 })
    if (id !== generation) return state
    input.log?.(`updater download started version=${version} generation=${id}`)
    let logged = -1
    await input.backend.downloadUpdate((value) => {
      if (id !== generation || state.status !== "downloading" || !Number.isFinite(value)) return
      const percent = Math.max(0, Math.min(100, value))
      const step = Math.floor(percent / 10)
      if (step !== logged) {
        input.log?.(`updater download progress version=${version} percent=${percent.toFixed(1)}`)
        logged = step
      }
      transition({ status: "downloading", version, percent })
    })
    if (id !== generation) return state
    await input.persistence.set({ version })
    if (id !== generation) {
      await input.persistence.clear()
      return state
    }
    input.log?.(`updater download completed version=${version}`)
    return transition({ status: "ready", version })
  }

  const check = () => {
    if (!input.enabled) {
      input.log?.("updater check skipped reason=disabled")
      return Promise.resolve(state)
    }
    if (state.status === "ready" || state.status === "installing" || state.status === "paused") {
      input.log?.(`updater check skipped reason=state-${state.status}`)
      return Promise.resolve(state)
    }
    if (pending) {
      input.log?.("updater check joined reason=check-already-running")
      return pending
    }

    return run(async (id) => {
      transition({ status: "checking" })
      if (id !== generation) return state
      input.log?.(`updater backend check started currentVersion=${input.currentVersion}`)
      const result = await input.backend.checkForUpdates()
      if (id !== generation) return state
      if (!result) throw new Error("Updater returned no check result")

      const version = result?.updateInfo?.version
      input.log?.(
        `updater backend check completed updateAvailable=${String(result.isUpdateAvailable)} releaseVersion=${version ?? "none"}`,
      )

      if (result.isUpdateAvailable === false) {
        await input.persistence.clear()
        if (id !== generation) return state
        input.log?.("updater check completed result=up-to-date")
        return transition({ status: "up-to-date" })
      }

      if (result.isUpdateAvailable !== true) {
        throw new Error("Updater returned an invalid update availability result")
      }
      if (!version) throw new Error("Updater reported an update without a version")

      if (normalizeVersion(version) === normalizeVersion(input.currentVersion)) {
        await input.persistence.clear()
        if (id !== generation) return state
        input.log?.(`updater check completed result=up-to-date reason=same-version version=${version}`)
        return transition({ status: "up-to-date" })
      }

      return download(version, id)
    })
  }

  return {
    getState: () => state,
    subscribe(listener: (state: UpdaterState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async start() {
      input.log?.(`updater start currentVersion=${input.currentVersion}`)
      const ready = await input.persistence.get()
      input.log?.(`updater persisted ready version=${ready?.version ?? "none"}`)
      if (ready?.version === input.currentVersion) {
        input.log?.("updater persisted ready state cleared reason=matches-current-version")
        await input.persistence.clear()
      }
      input.log?.("updater startup check skipped reason=manual-only")
      return state
    },
    check,
    pause() {
      if (state.status !== "downloading") return
      input.log?.(`updater pause requested version=${state.version} percent=${state.percent ?? 0}`)
      generation++
      transition({ ...state, status: "paused" })
      input.backend.cancelDownload?.()
    },
    async resume() {
      const id = generation
      await pending
      if (id !== generation) return pending ?? state
      if (state.status !== "paused") return state
      const version = state.version
      input.log?.(`updater resume requested version=${version} mode=restart-download`)
      return run((id) => download(version, id))
    },
    async cancel() {
      if (state.status !== "downloading" && state.status !== "paused" && state.status !== "checking") return
      input.log?.(`updater cancel requested status=${state.status}`)
      const id = ++generation
      transition({ status: "idle" })
      input.backend.cancelDownload?.()
      await pending
      if (id !== generation) return
      await input.persistence.clear()
      input.log?.("updater cancel completed")
    },
    async install() {
      if (state.status !== "ready") {
        input.log?.(`updater install skipped reason=state-${state.status}`)
        throw new Error("Update is not ready to install")
      }
      const version = state.version
      transition({ status: "installing", version })
      input.log?.(`updater install started version=${version}`)
      await input
        .stop()
        .then(() => {
          input.backend.quitAndInstall()
          input.log?.(`updater install requested version=${version}`)
          transition({ status: "ready", version })
        })
        .catch((error) => {
          input.log?.(`updater install failed message=${error instanceof Error ? error.message : String(error)}`)
          transition({ status: "ready", version })
          throw error
        })
    },
  }
}

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, "")
}

export type UpdaterController = ReturnType<typeof createUpdaterController>
