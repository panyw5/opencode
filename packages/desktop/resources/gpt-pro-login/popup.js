import { candidateNames, parseConnection } from "./common.js"

const fallback = {
  statusLoggedIn: "Logged in (session found)",
  statusLoggedOut: "Not logged in",
  statusUnknown: "Unable to check",
  statusReading: "Reading session…",
  statusImporting: "Importing…",
  statusImported: "Imported. Return to OpenCode GPT-Pro config page to verify.",
  errorTab: "Open a new OpenCode-ChatGPT connection page on 127.0.0.1, then open this extension from that tab.",
  errorProfile: "Cannot identify this Chrome profile. Keep the OpenCode-ChatGPT connection tab active.",
  errorNoSession: "No supported ChatGPT session found. Log in to ChatGPT in this Chrome profile, then try again.",
  errorConnection: "Connection failed. Open a new connection from OpenCode.",
  errorImport: "Import not confirmed. Check the GPT-Pro config page in OpenCode.",
  errorInvalidSession:
    "The ChatGPT session is invalid or unsupported. Log in again in Chrome, then open a new connection from OpenCode.",
  errorUnauthorized: "Connection authorization failed. Open a new connection from OpenCode.",
  errorInUse: "This connection is already in use. Check OpenCode; do not repeatedly resend.",
  errorExpired: "The connection has expired. Open a new connection from OpenCode.",
}
const t = (key) => {
  const message = chrome.i18n.getMessage(key)
  if (message) return message
  console.warn(`[gpt-pro-extension] missing localization message key=${key}`)
  return fallback[key] ?? ""
}
const locale = t("@@ui_locale")
if (locale) document.documentElement.lang = locale.replaceAll("_", "-")
document.documentElement.dir = t("@@bidi_dir") || "ltr"
for (const element of document.querySelectorAll("[data-i18n]")) {
  const message = t(element.dataset.i18n)
  if (message) element.textContent = message
}

class ConnectorError extends Error {
  constructor(key) {
    super(t(key))
  }
}

const consent = document.querySelector("#consent")
const button = document.querySelector("#connect")
const status = document.querySelector("#status")
const loginState = document.querySelector("#login-state")
let running = false

async function activeProfile() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (typeof tab?.id !== "number") throw new ConnectorError("errorProfile")
  const stores = await chrome.cookies.getAllCookieStores()
  const store = stores.find((item) => item.tabIds.includes(tab.id))
  if (!store) throw new ConnectorError("errorProfile")
  return { tab, store }
}

async function readSessionCookies(storeId) {
  const groups = await Promise.all(
    candidateNames().map((name) => chrome.cookies.getAll({ url: "https://chatgpt.com/", name, secure: true, storeId })),
  )
  return groups
    .flat()
    .filter(
      (cookie) =>
        ["chatgpt.com", ".chatgpt.com"].includes(cookie.domain) &&
        cookie.httpOnly &&
        cookie.path === "/" &&
        !cookie.partitionKey,
    )
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      hostOnly: cookie.hostOnly,
      sameSite: cookie.sameSite,
      session: cookie.session,
      ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
    }))
}

async function refreshLoginStatus() {
  loginState.textContent = t("statusChecking")
  try {
    const { store } = await activeProfile()
    const cookies = await readSessionCookies(store.id)
    loginState.textContent = t(cookies.length ? "statusLoggedIn" : "statusLoggedOut")
  } catch (error) {
    console.warn("[gpt-pro-extension] could not check ChatGPT login status", error)
    loginState.textContent = t("statusUnknown")
  }
}

consent.addEventListener("change", () => {
  button.disabled = running || !consent.checked
})

void refreshLoginStatus()

button.addEventListener("click", async () => {
  if (running || !consent.checked) return
  running = true
  button.disabled = true
  status.textContent = t("statusReading")
  let sending = false
  try {
    let connection
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      connection = parseConnection(tab?.url ?? "")
    } catch {
      throw new ConnectorError("errorTab")
    }
    const { store } = await activeProfile()
    const cookies = await readSessionCookies(store.id)
    if (!cookies.length) throw new ConnectorError("errorNoSession")
    status.textContent = t("statusImporting")
    sending = true
    const response = await fetch(`${connection.origin}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ version: 1, cookies }),
      signal: AbortSignal.timeout(30000),
      credentials: "omit",
      redirect: "error",
    })
    const result = await response.json()
    if (!response.ok || result.phase !== "imported") {
      const errors = { 400: "errorInvalidSession", 403: "errorUnauthorized", 409: "errorInUse", 410: "errorExpired" }
      throw new ConnectorError(errors[response.status] ?? "errorImport")
    }
    status.textContent = t("statusImported")
  } catch (error) {
    status.textContent =
      error instanceof ConnectorError ? error.message : t(sending ? "errorImport" : "errorConnection")
  } finally {
    running = false
    consent.checked = false
    button.disabled = true
  }
})
