import { Component, Show, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Progress } from "@opencode-ai/ui/progress"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform, type UpdaterState } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { SettingsRow } from "./settings-row"
import { SettingsList } from "./settings-list"

export const SettingsUpdates: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()

  const [updater, setUpdater] = createStore<{
    state: UpdaterState
    busy: boolean
    installing: boolean
    checking: boolean
  }>({
    state: { status: "idle" },
    busy: false,
    installing: false,
    checking: false,
  })

  onMount(() => {
    if (!platform.getUpdaterState || !platform.onUpdaterStateChanged) return
    let received = false
    let disposed = false
    const unsubscribe = platform.onUpdaterStateChanged((state) => {
      received = true
      console.debug(`[settings-updater] state status=${state.status}`)
      setUpdater("state", state)
      if (state.status === "downloading") setUpdater("busy", false)
      if (state.status === "installing") setUpdater("installing", true)
      if (state.status === "ready" || state.status === "error" || state.status === "idle") {
        setUpdater("installing", false)
      }
    })
    void platform
      .getUpdaterState()
      .then((state) => {
        if (!disposed && !received) setUpdater("state", state)
      })
      .catch((error) => console.error(`[settings-updater] state read failed message=${String(error)}`))
    onCleanup(() => {
      disposed = true
      unsubscribe()
    })
  })

  const updateAction = async (action: "download" | "pause" | "resume" | "cancel" | "install") => {
    if (updater.busy || updater.installing) return
    setUpdater("busy", true)
    if (action === "install") setUpdater("installing", true)
    console.debug(`[settings-updater] action started action=${action}`)
    try {
      if (action === "download") await platform.downloadUpdate?.()
      if (action === "pause") await platform.pauseUpdate?.()
      if (action === "resume") await platform.resumeUpdate?.()
      if (action === "cancel") await platform.cancelUpdate?.()
      if (action === "install") await platform.updateAndRestart?.()
      console.debug(`[settings-updater] action completed action=${action}`)
    } catch (error) {
      if (action === "install") setUpdater("installing", false)
      console.error(`[settings-updater] action failed action=${action} message=${String(error)}`)
      showToast({ title: language.t("common.requestFailed"), description: String(error) })
    } finally {
      setUpdater("busy", false)
    }
  }

  const updateAvailable = createMemo(() => {
    const state = updater.state
    return state.status === "available" ? state : undefined
  })
  const updateTransfer = createMemo(() => {
    const state = updater.state
    return state.status === "downloading" || state.status === "paused" ? state : undefined
  })
  const updateReady = createMemo(() => {
    const state = updater.state
    return state.status === "ready" || state.status === "installing" ? state : undefined
  })

  const revealUpdate = (element: HTMLDivElement) => {
    onMount(() => {
      const container = element.closest("[data-settings-updates]")
      if (!(container instanceof HTMLElement)) return
      const hidden = element.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom
      if (hidden > 0) container.scrollBy({ top: hidden + 16, behavior: "smooth" })
    })
  }

  const check = () => {
    if (!platform.checkUpdate) return
    setUpdater("checking", true)
    console.debug("[settings-updater] check requested")

    void platform
      .checkUpdate()
      .then((result) => {
        if (platform.getUpdaterState) return
        if (result.failed) {
          showToast({
            title: language.t("common.requestFailed"),
            description: result.error ?? language.t("common.requestFailed"),
          })
          return
        }

        if (!result.updateAvailable) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
          return
        }

        const actions =
          platform.updateAndRestart || (platform.update && platform.restart)
            ? [
                {
                  label: language.t("toast.update.action.installRestart"),
                  onClick: async () => {
                    if (platform.updateAndRestart) return platform.updateAndRestart()
                    await platform.update!()
                    await platform.restart!()
                  },
                },
                {
                  label: language.t("toast.update.action.notYet"),
                  onClick: "dismiss" as const,
                },
              ]
            : [
                {
                  label: language.t("toast.update.action.notYet"),
                  onClick: "dismiss" as const,
                },
              ]

        showToast({
          persistent: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: result.version ?? "" }),
          actions,
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setUpdater("checking", false))
  }

  return (
    <div data-settings-updates class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.updates")}</h2>
          <span class="text-12-regular text-text-weak">
            {language.t("settings.updates.version.current", { version: platform.version ?? "" })}
          </span>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <div class="flex flex-col gap-1">
          <SettingsList>
            <SettingsRow
              title={language.t("settings.general.row.releaseNotes.title")}
              description={language.t("settings.general.row.releaseNotes.description")}
            >
              <div data-action="settings-release-notes">
                <Switch
                  checked={settings.general.releaseNotes()}
                  onChange={(checked) => settings.general.setReleaseNotes(checked)}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.updates.row.check.title")}
              description={language.t("settings.updates.row.check.description")}
            >
              <Button
                data-action="settings-check-update"
                size="small"
                variant="secondary"
                disabled={
                  updater.checking ||
                  updater.busy ||
                  updater.state.status === "disabled" ||
                  !!updateTransfer() ||
                  !!updateReady() ||
                  !platform.checkUpdate
                }
                onClick={check}
              >
                {updater.state.status === "checking" || (updater.checking && !platform.getUpdaterState)
                  ? language.t("settings.updates.action.checking")
                  : language.t("settings.updates.action.checkNow")}
              </Button>
            </SettingsRow>

            <Show when={updateAvailable()}>
              {(available) => (
                <div
                  data-testid="settings-update-available"
                  class="flex flex-col gap-3 px-4 py-4 border-t border-border-weak-base"
                  ref={revealUpdate}
                >
                  <span class="text-12-medium text-text-strong" aria-live="polite">
                    {language.t("settings.updates.available.title", { version: available().version })}
                  </span>
                  <Show when={available().notes}>
                    <div class="max-h-48 overflow-y-auto rounded-md bg-surface-base px-3 py-2">
                      <p class="text-12-regular text-text-base whitespace-pre-wrap">{available().notes}</p>
                    </div>
                  </Show>
                  <Show when={available().error}>
                    <span class="text-12-regular text-text-danger-base">{available().error}</span>
                  </Show>
                  <div class="flex justify-end">
                    <Button
                      size="small"
                      variant="primary"
                      data-action="settings-update-download"
                      disabled={updater.busy || !platform.downloadUpdate}
                      onClick={() => void updateAction("download")}
                    >
                      {language.t(
                        available().error
                          ? "settings.updates.action.redownload"
                          : "settings.updates.action.download",
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </Show>

            <Show when={updateTransfer()}>
              {(transfer) => (
                <div
                  data-testid="settings-update-download"
                  class="flex flex-col gap-3 px-4 py-4 border-t border-border-weak-base"
                  ref={revealUpdate}
                >
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-12-medium text-text-strong" aria-live="polite">
                      {language.t(
                        transfer().status === "paused"
                          ? "settings.updates.download.paused"
                          : "settings.updates.download.downloading",
                        { version: transfer().version },
                      )}
                    </span>
                    <div class="flex items-center gap-1">
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={updater.busy}
                        data-action="settings-update-pause"
                        aria-label={language.t(
                          transfer().status === "paused"
                            ? "settings.updates.action.resume"
                            : "settings.updates.action.pause",
                        )}
                        title={language.t(
                          transfer().status === "paused"
                            ? "settings.updates.download.resumeHint"
                            : "settings.updates.action.pause",
                        )}
                        onClick={() => void updateAction(transfer().status === "paused" ? "resume" : "pause")}
                      >
                        <Icon name={transfer().status === "paused" ? "play" : "pause"} size="small" />
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={updater.busy}
                        data-action="settings-update-cancel"
                        aria-label={language.t("settings.updates.action.cancel")}
                        title={language.t("settings.updates.action.cancel")}
                        onClick={() => void updateAction("cancel")}
                      >
                        <Icon name="close-small" size="small" />
                      </Button>
                    </div>
                  </div>
                  <Progress value={transfer().percent ?? 0} maxValue={100} showValueLabel hideLabel>
                    {language.t("settings.updates.download.progress")}
                  </Progress>
                  <Show when={transfer().status === "paused"}>
                    <span class="text-12-regular text-text-weak">
                      {language.t("settings.updates.download.resumeHint")}
                    </span>
                  </Show>
                </div>
              )}
            </Show>

            <Show when={updateReady()}>
              {(ready) => (
                <div
                  data-testid="settings-update-ready"
                  class="flex flex-wrap items-center justify-between gap-3 px-4 py-4 border-t border-border-weak-base"
                  ref={revealUpdate}
                >
                  <span class="text-12-medium text-text-strong" aria-live="polite">
                    {language.t("settings.updates.download.ready", { version: ready().version })}
                  </span>
                  <div class="flex items-center gap-2">
                    <Button
                      size="small"
                      variant="secondary"
                      data-action="settings-update-redownload"
                      disabled={updater.busy || updater.installing || ready().status === "installing"}
                      onClick={() => void updateAction("download")}
                    >
                      {language.t("settings.updates.action.redownload")}
                    </Button>
                    <Button
                      size="small"
                      variant="primary"
                      data-action="settings-update-install"
                      disabled={
                        updater.busy || updater.installing || ready().status === "installing" || !platform.updateAndRestart
                      }
                      onClick={() => void updateAction("install")}
                    >
                      {language.t(
                        updater.installing || ready().status === "installing"
                          ? "settings.updates.action.installing"
                          : "toast.update.action.installRestart",
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </Show>

            <Show when={updater.state.status === "error" || updater.state.status === "up-to-date"}>
              <div role="status" class="px-4 py-4 text-12-regular text-text-weak border-t border-border-weak-base">
                {updater.state.status === "error"
                  ? updater.state.message
                  : language.t("settings.updates.toast.latest.title")}
              </div>
            </Show>
          </SettingsList>
        </div>
      </div>
    </div>
  )
}
