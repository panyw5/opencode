import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { PlatformProvider, type Platform } from "../../../app/src/context/platform"
import { LanguageProvider } from "../../../app/src/context/language"
import { SettingsRemote } from "../../../app/src/components/settings-remote"
import type { RemoteAccessApi, RemoteAccessStatus } from "../../../app/src/remote/types"
import "../../../app/src/index.css"

// Loaded only by remote-progress-cdp.ts, never by the application entry point.
const startedAt = Date.now() - 123_000
let status: RemoteAccessStatus = {
  enabled: true,
  phase: "connecting",
  stage: "waiting-certificate",
  startedAt,
  stageStartedAt: startedAt + 1_000,
}
const listeners = new Set<(value: RemoteAccessStatus) => void>()
let stops = 0
const emit = () => {
  for (const listener of listeners) listener({ ...status })
}
const remoteAccess: RemoteAccessApi = {
  status: async () => ({ ...status }),
  devices: async () => [],
  onStatus: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  enable: async () => ({ ...status }),
  disable: async () => {
    stops++
    return { enabled: false, phase: "disabled" }
  },
  pair: async () => {
    throw new Error("Pairing is disabled in this fixture")
  },
  revoke: async () => {
    throw new Error("Revocation is disabled in this fixture")
  },
  reset: async () => {
    throw new Error("Reset is disabled in this fixture")
  },
}
const platform: Platform = {
  platform: "web",
  version: "QA",
  openLink: () => {},
  restart: async () => {},
  back: () => {},
  forward: () => {},
  notify: async () => {},
  remoteAccess,
}
const [opened, setOpened] = createSignal(true)
Object.assign(window, {
  __remoteProgressFixture: {
    mount: () => setOpened(true),
    close: () => setOpened(false),
    stage: (stage: RemoteAccessStatus["stage"]) => {
      status = { ...status, stage, stageStartedAt: Date.now() }
      emit()
    },
    complete: () => {
      status = { enabled: true, phase: "online", url: "https://qa.invalid" }
      emit()
    },
    reconnect: () => {
      status = { enabled: true, phase: "reconnecting", startedAt: Date.now() }
      emit()
    },
    disabled: () => {
      status = { enabled: false, phase: "disabled" }
      emit()
    },
    inspect: () => ({ startedAt, stops, listeners: listeners.size, phase: status.phase }),
  },
})
render(
  () => (
    <PlatformProvider value={platform}>
      <LanguageProvider locale="zh">
        <Show when={opened()}>
          <SettingsRemote />
        </Show>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
