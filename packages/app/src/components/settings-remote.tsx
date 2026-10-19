import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import QRCode from "qrcode"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { RemoteAccessStatus, RemoteDevice, RemotePairing } from "@/remote/types"
import {
  createPairingOperationController,
  deviceActivityAt,
  pairingRemainingSeconds,
  revokeAfterConfirmation,
  shouldClearPairing,
  sortRemoteDevices,
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
    deviceSort: "activity" as "activity" | "paired",
  })
  const devices = createMemo(() => sortRemoteDevices(store.devices, store.deviceSort))
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
      setStore("devices", reconcile(devices, { key: "id" }))
      setStore({ status, error: "" })
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
    let ticks = 0
    timer = setInterval(() => {
      if (++ticks % 5 === 0 && !store.busy) void refresh()
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

  const date = (value: number) =>
    new Date(value).toLocaleString(language.locale(), {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
  const connectionState = (device: RemoteDevice) =>
    store.status.phase === "online" ? (device.connection?.state ?? "unknown") : "offline"

  return (
    <div data-component="settings-remote" class="flex flex-col gap-6 px-6 py-5">
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
              <span data-slot="remote-public-address" class="select-text text-13-regular text-text-base break-all">
                {url()}
              </span>
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
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h3 class="text-14-medium">{language.t("settings.remote.devices")}</h3>
          <select
            data-slot="remote-device-sort"
            aria-label={language.t("settings.remote.sort")}
            class="ml-auto rounded-md border border-border-base bg-background-base px-2 py-1 text-12-regular"
            value={store.deviceSort}
            onChange={(event) => setStore("deviceSort", event.currentTarget.value === "paired" ? "paired" : "activity")}
          >
            <option value="activity">{language.t("settings.remote.sort.activity")}</option>
            <option value="paired">{language.t("settings.remote.sort.paired")}</option>
          </select>
          <Button size="small" variant="ghost" disabled={store.busy} onClick={reset}>
            {language.t("settings.remote.reset")}
          </Button>
        </div>
        <p class="text-12-regular text-text-weak">{language.t("settings.remote.presenceHint")}</p>
        <Show
          when={store.devices.length > 0}
          fallback={<p class="text-13-regular text-text-weak">{language.t("settings.remote.devicesEmpty")}</p>}
        >
          <div class="rounded-lg border border-border-base bg-surface-base divide-y divide-border-base">
            <For each={devices()}>
              {(device) => (
                <div
                  data-slot="remote-device"
                  data-device-id={device.id}
                  class="flex items-center justify-between gap-3 p-3"
                >
                  <div class="min-w-0 flex flex-col gap-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="text-14-medium truncate">{device.name}</span>
                      <span
                        data-slot="remote-device-state"
                        data-state={connectionState(device)}
                        class="rounded-full border border-border-base px-2 py-0.5 text-11-regular"
                        classList={{ "text-text-success-base": connectionState(device) === "active" }}
                      >
                        {language.t(`settings.remote.connection.${connectionState(device)}`)}
                      </span>
                      <code class="text-11-regular text-text-weak">#{device.id.slice(0, 8)}</code>
                    </div>
                    <span data-slot="remote-device-paired" class="text-12-regular text-text-weak">
                      {language.t("settings.remote.devicePaired", { date: date(device.createdAt) })}
                    </span>
                    <span data-slot="remote-device-seen" class="text-12-regular text-text-weak">
                      {language.t("settings.remote.deviceSeen", { date: date(deviceActivityAt(device)) })}
                    </span>
                    <Show when={store.status.phase === "online"}>
                      <For each={device.connection?.pages ?? []}>
                        {(page) => (
                          <span data-slot="remote-device-page" class="break-all text-12-regular text-text-base">
                            {language.t("settings.remote.currentPage")}：
                            {language.t(`settings.remote.page.${page.kind}`)}
                            {page.project ? ` · ${page.project}` : ""}
                            {page.sessionID ? ` · #${page.sessionID.slice(-8)}` : ""}
                            {!page.visible ? ` · ${language.t("settings.remote.connection.background")}` : ""}
                          </span>
                        )}
                      </For>
                    </Show>
                  </div>
                  <Button size="small" variant="ghost" disabled={store.busy} onClick={() => revoke(device)}>
                    {language.t("settings.remote.revoke")}
                  </Button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </div>
  )
}
