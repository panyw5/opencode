// @refresh reload

import * as Sentry from "@sentry/solid"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import { authFromToken } from "@/utils/server"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"
import { bootstrapRemoteSession, createRemoteFetch, RemoteSessionError } from "./remote/bootstrap"
import { installWebViewport } from "./utils/web-viewport"
import { installRemotePresence } from "./remote/presence"

const disposeViewport = installWebViewport()
if (import.meta.hot) import.meta.hot.dispose(disposeViewport)

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "https://opencode.ai/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (import.meta.env.VITE_OPENCODE_REMOTE === "true") return location.origin
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const remoteMode = import.meta.env.VITE_OPENCODE_REMOTE === "true"

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

let remoteCsrfToken: string | undefined
let disposePresence: (() => void) | undefined
if (import.meta.hot) import.meta.hot.dispose(() => disposePresence?.())
const remoteFetch = createRemoteFetch(() => remoteCsrfToken, location.origin)

const platform: Platform = {
  platform: "web",
  remoteMode,
  fetch: remoteMode ? (remoteFetch as typeof fetch) : undefined,
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  getDefaultServer: async () => {
    if (remoteMode) return null
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: remoteMode ? () => {} : writeDefaultServerUrl,
}

const showRemoteBootstrapError = (error: unknown, retry: () => void) => {
  if (!(root instanceof HTMLElement)) return
  const locale = getLocale()
  const expired = error instanceof RemoteSessionError && error.kind === "unauthenticated"
  const message = document.createElement("p")
  message.textContent =
    locale === "zh"
      ? expired
        ? zh["error.remote.sessionExpired"]
        : zh["error.remote.sessionUnavailable"]
      : expired
        ? en["error.remote.sessionExpired"]
        : en["error.remote.sessionUnavailable"]
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = locale === "zh" ? zh["error.remote.retry"] : en["error.remote.retry"]
  button.addEventListener("click", () => {
    button.disabled = true
    root.textContent = locale === "zh" ? zh["error.remote.retrying"] : en["error.remote.retrying"]
    retry()
  })
  root.replaceChildren(message, button)
}

if (import.meta.env.VITE_SENTRY_DSN && !remoteMode) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "web",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

if (root instanceof HTMLElement) {
  const start = async () => {
    let auth: ReturnType<typeof authFromToken> = undefined
    if (remoteMode) {
      clearAuthToken()
      try {
        const session = await bootstrapRemoteSession()
        remoteCsrfToken = session.csrfToken
        if (session.capabilities?.presence) {
          disposePresence?.()
          disposePresence = installRemotePresence(remoteFetch as typeof fetch)
        }
      } catch (error) {
        showRemoteBootstrapError(error, () => void start())
        return
      }
    } else {
      auth = authFromToken(new URLSearchParams(location.search).get("auth_token"))
      clearAuthToken()
    }
    const server: ServerConnection.Http = {
      type: "http",
      authToken: !!auth,
      http: {
        url: getCurrentUrl(),
        ...auth,
      },
    }
    render(
      () => (
        <PlatformProvider value={platform}>
          <AppBaseProviders>
            <AppInterface
              defaultServer={ServerConnection.Key.make(remoteMode ? location.origin : getDefaultUrl())}
              servers={[server]}
              disableHealthCheck
            />
          </AppBaseProviders>
        </PlatformProvider>
      ),
      root,
    )
  }
  void start()
}
