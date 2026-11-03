import { render } from "solid-js/web"
import { createMemoryHistory, MemoryRouter, type BaseRouterProps } from "@solidjs/router"
import { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection, type Platform } from "@opencode-ai/app"
import "../../../app/src/index.css"

// This fixture uses isolated browser storage and a disposable sidecar, not desktop persistence.
const params = new URL(location.href).searchParams
const backend = params.get("backend")!
const directory = params.get("directory")!
const source = params.get("source")!
const prefix = "context-access-qa:"
const storage: NonNullable<Platform["storage"]> = (name = "default.dat") => ({
  getItem: (key) => sessionStorage.getItem(`${prefix}${name}:${key}`),
  setItem: (key, value) => sessionStorage.setItem(`${prefix}${name}:${key}`, value),
  removeItem: (key) => sessionStorage.removeItem(`${prefix}${name}:${key}`),
})
if (!storage().getItem("settings.v3")) {
  storage().setItem("settings.v3", JSON.stringify({ assistant: { model: { providerID: "qa", modelID: "qa-model" } } }))
}
const platform: Platform = {
  platform: "desktop",
  os: "macos",
  openLink: () => {},
  restart: async () => {},
  back: () => {},
  forward: () => {},
  notify: async () => {},
  storage,
}
const history = createMemoryHistory()
const navigate = (directory: string, sessionID: string) => {
  history.set({
    value: `/${btoa(directory).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}/session/${sessionID}`,
    replace: true,
  })
  console.debug(`[context-access-qa] main session selected session=${sessionID} directory=${directory}`)
}
navigate(directory, source)
window.addEventListener("context-access-qa:navigate", (event) => {
  const target = (event as CustomEvent<{ directory: string; sessionID: string }>).detail
  navigate(target.directory, target.sessionID)
})
const Router = (props: BaseRouterProps) => <MemoryRouter {...props} history={history} />
render(
  () => (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale="en">
        <AppInterface
          defaultServer={ServerConnection.Key.make("sidecar")}
          servers={[{ type: "sidecar", variant: "base", displayName: "Isolated QA sidecar", http: { url: backend } }]}
          router={Router}
        />
      </AppBaseProviders>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
