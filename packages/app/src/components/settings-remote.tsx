import { Component, Show, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import QRCode from "qrcode"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { RemoteAccessStatus, RemoteDevice, RemotePairing } from "@/remote/types"
import {
  createPairingOperationController,
  pairingRemainingSeconds,
  revokeAfterConfirmation,
  shouldClearPairing,
} from "@/remote/access-ui"

export const SettingsRemote: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const api = platform.remoteAccess!
  const [store, setStore] = createStore({
    status: { enabled: false, phase: "disabled" } as RemoteAccessStatus,
    devices: [] as RemoteDevice[],
    pairing: undefined as (RemotePairing & { qr: string }) | undefined,
    busy: false,
    pairingBusy: false,
    disabling: false,
    error: "",
  })
  const [remaining, setRemaining] = createSignal(0)
  let generation = 0
  let eventGeneration = 0
  let actionGeneration = 0
  const pairingOperation = createPairingOperationController()
  let lastUrl: string | undefined
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined

  const invalidatePairing = () => {
    pairingOperation.invalidate()
    setStore({ pairing: undefined, pairingBusy: false })
    if (expiryTimer) clearTimeout(expiryTimer)
    expiryTimer = undefined
  }

  const refresh = async () => {
    const current = ++generation
    const currentEvent = eventGeneration
    try {
      const status = await api.status()
      const devices = await api.devices()
      if (disposed || current !== generation || currentEvent !== eventGeneration) return
      if (shouldClearPairing({ status, previousUrl: lastUrl, devices, previousDevices: store.devices })) {
        invalidatePairing()
      }
      lastUrl = status.url
      setStore({ status, devices, error: "" })
    } catch (error) {
      if (disposed || current !== generation || currentEvent !== eventGeneration) return
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  onMount(() => {
    const unsubscribe = api.onStatus((status) => {
      if (disposed) return
      eventGeneration++
      if (
        shouldClearPairing({ status, previousUrl: lastUrl, devices: store.devices, previousDevices: store.devices })
      ) {
        invalidatePairing()
      }
      setStore("status", status)
      void refresh()
    })
    void refresh()
    timer = setInterval(() => {
      const expiresAt = store.pairing?.expiresAt
      if (!expiresAt) return
      const value = pairingRemainingSeconds(expiresAt)
      setRemaining(value)
      if (value === 0) setStore("pairing", undefined)
    }, 1000)
    onCleanup(() => {
      disposed = true
      generation++
      unsubscribe()
      if (timer) clearInterval(timer)
      if (expiryTimer) clearTimeout(expiryTimer)
    })
  })

  const act = async (operation: () => Promise<RemoteAccessStatus | void>, allowBusy = false) => {
    if (store.busy && !allowBusy) return
    const current = ++actionGeneration
    setStore({ busy: true, error: "" })
    try {
      const status = await operation()
      if (disposed || current !== actionGeneration) return
      if (status) setStore("status", status)
      await refresh()
    } catch (error) {
      if (!disposed && current === actionGeneration) {
        setStore("error", error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (!disposed && current === actionGeneration) setStore("busy", false)
    }
  }

  const enable = () => {
    if (!window.confirm(language.t("settings.remote.enableConfirm"))) return
    void act(() => api.enable())
  }

  const retry = () => {
    if (!store.status.enabled) {
      void refresh()
      return
    }
    void act(() => api.enable())
  }

  const disable = async () => {
    if (store.disabling) return
    invalidatePairing()
    setStore("disabling", true)
    await act(() => api.disable(), true)
    if (!disposed) setStore("disabling", false)
  }

  const pair = async () => {
    if (store.busy || store.pairingBusy) return
    invalidatePairing()
    const current = pairingOperation.start()
    if (current === undefined) return
    setStore({ error: "", pairingBusy: true })
    try {
      const pairing = await api.pair()
      const qr = await QRCode.toDataURL(pairing.url, { margin: 1, width: 224, errorCorrectionLevel: "M" })
      if (disposed || !pairingOperation.isCurrent(current) || store.status.phase !== "online") return
      setStore("pairing", { ...pairing, qr })
      setRemaining(pairingRemainingSeconds(pairing.expiresAt))
      if (expiryTimer) clearTimeout(expiryTimer)
      expiryTimer = setTimeout(
        () => {
          if (!pairingOperation.isCurrent(current)) return
          invalidatePairing()
          setRemaining(0)
        },
        Math.max(0, pairing.expiresAt - Date.now()),
      )
    } catch (error) {
      if (!disposed && pairingOperation.isCurrent(current)) {
        setStore("error", error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (!disposed && pairingOperation.finish(current)) setStore("pairingBusy", false)
    }
  }

  const copy = async () => {
    if (!store.pairing) return
    try {
      await navigator.clipboard.writeText(store.pairing.url)
      showToast({ title: language.t("settings.remote.copied") })
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const revoke = (device: RemoteDevice) => {
    void revokeAfterConfirmation(
      device.id,
      () => window.confirm(language.t("settings.remote.revokeConfirm", { name: device.name })),
      (id) => act(async () => api.revoke(id)),
    )
  }

  const reset = () => {
    if (!window.confirm(language.t("settings.remote.resetConfirm"))) return
    invalidatePairing()
    void act(() => api.reset())
  }

  const date = (value: number) => new Date(value).toLocaleDateString()

  return (
    <div class="flex flex-col gap-6 px-6 py-5">
      <header class="flex flex-col gap-1">
        <h2 class="text-18-semibold">{language.t("settings.remote.title")}</h2>
        <p class="text-14-regular text-text-weak">{language.t("settings.remote.description")}</p>
      </header>
      <div class="rounded-lg border border-border-base bg-surface-base p-4 flex flex-col gap-3">
        <div class="flex items-center gap-2 text-14-medium">
          <Icon name={store.status.phase === "online" ? "circle-check" : "settings-gear"} />
          {language.t(`settings.remote.phase.${store.status.phase}`)}
        </div>
        <Show when={store.status.error || store.error}>
          <p role="alert" class="text-13-regular text-icon-critical-base">
            {store.error || store.status.error}
          </p>
        </Show>
        <Show when={store.status.phase === "error" || store.error}>
          <Button size="small" disabled={store.busy} onClick={retry}>
            {language.t("settings.remote.retry")}
          </Button>
        </Show>
        <Show when={!store.status.enabled && !store.busy}>
          <p class="text-13-regular text-text-weak">{language.t("settings.remote.enableDescription")}</p>
          <Button size="small" variant="primary" disabled={store.busy} onClick={enable}>
            {language.t("settings.remote.enable")}
          </Button>
        </Show>
        <Show when={store.status.enabled || store.busy}>
          <Show when={store.status.url}>
            {(url) => (
              <div class="flex flex-col items-start gap-2">
                <span class="select-text text-13-regular text-text-base break-all">{url()}</span>
                <Button size="small" variant="ghost" onClick={() => platform.openLink(url())}>
                  {language.t("settings.remote.openUrl")}
                </Button>
              </div>
            )}
          </Show>
          <div class="flex flex-wrap gap-2">
            <Button
              size="small"
              disabled={store.busy || store.pairingBusy || store.status.phase !== "online"}
              onClick={() => void pair()}
            >
              {language.t("settings.remote.pair")}
            </Button>
            <Button size="small" variant="ghost" disabled={store.disabling} onClick={() => void disable()}>
              {language.t("settings.remote.disable")}
            </Button>
          </div>
        </Show>
      </div>
      <Show when={store.pairing && remaining() > 0}>
        {(pairing) => (
          <div class="rounded-lg border border-border-base bg-surface-base p-4 flex flex-col items-start gap-3">
            <h3 class="text-14-medium">{language.t("settings.remote.pairTitle")}</h3>
            <img
              class="size-56 rounded bg-white p-2"
              src={store.pairing?.qr}
              alt={language.t("settings.remote.qrAlt")}
            />
            <p class="text-13-regular text-text-weak">
              {language.t("settings.remote.pairExpires", { seconds: remaining() })}
            </p>
            <Button size="small" onClick={() => void copy()}>
              {language.t("settings.remote.copyLink")}
            </Button>
          </div>
        )}
      </Show>
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-14-medium">{language.t("settings.remote.devices")}</h3>
          <Button size="small" variant="ghost" disabled={store.busy} onClick={reset}>
            {language.t("settings.remote.reset")}
          </Button>
        </div>
        <Show
          when={store.devices.length > 0}
          fallback={<p class="text-13-regular text-text-weak">{language.t("settings.remote.devicesEmpty")}</p>}
        >
          <div class="rounded-lg border border-border-base bg-surface-base divide-y divide-border-base">
            {store.devices.map((device) => (
              <div class="flex items-center justify-between gap-3 p-3">
                <div class="min-w-0 flex flex-col gap-1">
                  <span class="text-14-medium truncate">{device.name}</span>
                  <span class="text-12-regular text-text-weak">
                    {language.t("settings.remote.deviceSeen", { date: date(device.lastSeenAt) })}
                  </span>
                </div>
                <Button size="small" variant="ghost" disabled={store.busy} onClick={() => revoke(device)}>
                  {language.t("settings.remote.revoke")}
                </Button>
              </div>
            ))}
          </div>
        </Show>
      </section>
    </div>
  )
}
