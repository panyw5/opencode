export type UpdaterState =
  | { status: "disabled" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "ready"; version: string }
  | { status: "up-to-date" }
  | { status: "installing"; version: string }
  | { status: "error"; message: string }

export type UpdaterReadyRecord = { version: string }

export type UpdaterBackend = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>
  downloadUpdate(): Promise<unknown>
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
  const listeners = new Set<(state: UpdaterState) => void>()

  const transition = (next: UpdaterState) => {
    input.log?.(`updater state changed from=${state.status} to=${next.status}`)
    state = next
    listeners.forEach((listener) => listener(state))
    return state
  }

  const check = () => {
    if (!input.enabled) {
      input.log?.("updater check skipped reason=disabled")
      return Promise.resolve(state)
    }
    if (state.status === "ready") {
      input.log?.("updater check skipped reason=update-already-ready")
      return Promise.resolve(state)
    }
    if (pending) {
      input.log?.("updater check joined reason=check-already-running")
      return pending
    }

    pending = (async () => {
      transition({ status: "checking" })
      input.log?.(`updater backend check started currentVersion=${input.currentVersion}`)
      const result = await input.backend.checkForUpdates()
      if (!result) throw new Error("Updater returned no check result")

      const version = result?.updateInfo?.version
      input.log?.(
        `updater backend check completed updateAvailable=${String(result.isUpdateAvailable)} releaseVersion=${version ?? "none"}`,
      )

      if (result.isUpdateAvailable === false) {
        await input.persistence.clear()
        input.log?.("updater check completed result=up-to-date")
        return transition({ status: "up-to-date" })
      }

      if (result.isUpdateAvailable !== true) {
        throw new Error("Updater returned an invalid update availability result")
      }
      if (!version) throw new Error("Updater reported an update without a version")

      if (normalizeVersion(version) === normalizeVersion(input.currentVersion)) {
        await input.persistence.clear()
        input.log?.(`updater check completed result=up-to-date reason=same-version version=${version}`)
        return transition({ status: "up-to-date" })
      }

      transition({ status: "downloading", version })
      input.log?.(`updater download started version=${version}`)
      await input.backend.downloadUpdate()
      await input.persistence.set({ version })
      input.log?.(`updater download completed version=${version}`)
      return transition({ status: "ready", version })
    })()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        input.log?.(`updater check failed message=${message}`)
        return transition({ status: "error", message })
      })
      .finally(() => {
        pending = undefined
      })
    return pending
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
      return check()
    },
    check,
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
