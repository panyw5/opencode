import { candidateNames, parseConnection } from "./common.js"

const t = (key) => chrome.i18n.getMessage(key)
document.documentElement.lang = t("@@ui_locale").replaceAll("_", "-")
document.documentElement.dir = t("@@bidi_dir")
for (const element of document.querySelectorAll("[data-i18n]")) {
  element.textContent = t(element.dataset.i18n)
}

class ConnectorError extends Error {
  constructor(key) {
    super(t(key))
  }
}

const consent = document.querySelector("#consent")
const button = document.querySelector("#connect")
const status = document.querySelector("#status")
let running = false
consent.addEventListener("change", () => {
  button.disabled = running || !consent.checked
})

button.addEventListener("click", async () => {
  if (running || !consent.checked) return
  running = true
  button.disabled = true
  status.textContent = t("statusReading")
  let sending = false
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    let connection
    try {
      connection = parseConnection(tab?.url ?? "")
    } catch {
      throw new ConnectorError("errorTab")
    }
    const stores = await chrome.cookies.getAllCookieStores()
    const store = stores.find((item) => item.tabIds.includes(tab.id))
    if (!store) throw new ConnectorError("errorProfile")
    const groups = await Promise.all(
      candidateNames().map((name) =>
        chrome.cookies.getAll({ url: "https://chatgpt.com/", name, secure: true, storeId: store.id }),
      ),
    )
    const cookies = groups
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
