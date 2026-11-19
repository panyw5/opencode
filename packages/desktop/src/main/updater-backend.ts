import pkg, { type AppUpdater, type UpdateInfo } from "electron-updater"
import type { UpdaterBackend } from "./updater-controller"

const { CancellationToken } = pkg

function releaseNotes(value: UpdateInfo["releaseNotes"]): string | undefined {
  if (!value) return undefined
  if (typeof value === "string") return value.trim() || undefined
  const text = value
    .map((entry) => entry.note ?? "")
    .filter((note) => note.trim().length > 0)
    .join("\n\n")
    .trim()
  return text || undefined
}

export function createUpdaterBackend(updater: AppUpdater, log: (message: string) => void): UpdaterBackend {
  let downloadToken: InstanceType<typeof CancellationToken> | undefined
  return {
    checkForUpdates: async () => {
      const result = await updater.checkForUpdates()
      if (!result) return result
      return {
        isUpdateAvailable: result.isUpdateAvailable,
        updateInfo: result.updateInfo
          ? { version: result.updateInfo.version, notes: releaseNotes(result.updateInfo.releaseNotes) }
          : undefined,
      }
    },
    async downloadUpdate(onProgress) {
      const token = new CancellationToken()
      downloadToken = token
      const progress = (info: { percent: number }) => onProgress?.(info.percent)
      updater.on("download-progress", progress)
      try {
        return await updater.downloadUpdate(token)
      } finally {
        updater.removeListener("download-progress", progress)
        if (downloadToken === token) downloadToken = undefined
        log(`updater download transport settled cancelled=${token.cancelled}`)
      }
    },
    cancelDownload() {
      log(`updater download transport cancel active=${Boolean(downloadToken)}`)
      downloadToken?.cancel()
    },
    quitAndInstall: () => updater.quitAndInstall(),
  }
}
