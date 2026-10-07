import pkg, { type AppUpdater } from "electron-updater"
import type { UpdaterBackend } from "./updater-controller"

const { CancellationToken } = pkg

export function createUpdaterBackend(updater: AppUpdater, log: (message: string) => void): UpdaterBackend {
  let downloadToken: InstanceType<typeof CancellationToken> | undefined
  return {
    checkForUpdates: () => updater.checkForUpdates(),
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
