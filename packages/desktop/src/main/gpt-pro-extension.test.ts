import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { candidateNames, parseConnection } from "../../resources/gpt-pro-login/common.js"

const source = readFileSync(new URL("../../resources/gpt-pro-login/popup.js", import.meta.url), "utf8").replace(
  /^import[^\n]*\n/,
  "",
)
const token = "a".repeat(64)
const cookie = {
  name: "__Secure-next-auth.session-token",
  value: "SYNTHETIC_PRIVATE_VALUE",
  domain: ".chatgpt.com",
  path: "/",
  secure: true,
  httpOnly: true,
  hostOnly: false,
  sameSite: "lax",
  session: true,
}

const localeDirectory = new URL("../../resources/gpt-pro-login/_locales/", import.meta.url)
const locales = readdirSync(localeDirectory)
const catalogs = Object.fromEntries(
  locales.map((locale) => [
    locale,
    JSON.parse(readFileSync(new URL(`${locale}/messages.json`, localeDirectory), "utf8")),
  ]),
) as Record<string, Record<string, { message: string }>>
const markup = readFileSync(new URL("../../resources/gpt-pro-login/popup.html", import.meta.url), "utf8")

function popup(
  input: {
    url?: string
    cookies?: unknown[]
    locale?: string
    missingMessages?: boolean
    stores?: unknown[]
    responseStatus?: number
    responseCode?: string
    networkFailure?: boolean
    beforeResponse?: () => Promise<void>
  } = {},
) {
  const consent = {
    checked: false,
    disabled: false,
    addEventListener: (event: string, fn: () => void) => {
      handlers[`consent:${event}`] = fn
    },
  }
  const button = {
    disabled: true,
    dataset: { state: "idle" },
    attributes: {} as Record<string, string>,
    setAttribute: (key: string, value: string) => {
      button.attributes[key] = value
    },
    addEventListener: (event: string, fn: () => Promise<void>) => {
      handlers[`button:${event}`] = fn
    },
  }
  const buttonLabel = { textContent: "" }
  const successIcon = {
    hidden: true,
    toggleAttribute: (name: string, present: boolean) => {
      if (name === "hidden") successIcon.hidden = present
    },
  }
  const status = { textContent: "" }
  const loginState = { textContent: "" }
  const root = { lang: "", dir: "" }
  const localized = Object.fromEntries(
    [...markup.matchAll(/data-i18n="([^"]+)"/g)].map((match) => {
      const key = match[1]
      const node =
        key === "statusApproval"
          ? status
          : key === "connect"
            ? buttonLabel
            : key === "statusChecking"
              ? loginState
              : { textContent: "" }
      const fallback = catalogs.en[key]?.message ?? ""
      return [key, Object.assign(node, { dataset: { i18n: key }, textContent: fallback })]
    }),
  )
  const handlers: Record<string, () => void | Promise<void>> = {}
  const queries: Array<Record<string, unknown>> = []
  const requests: Array<{ url: string; init: Record<string, unknown> }> = []
  runInNewContext(source, {
    candidateNames,
    parseConnection,
    Error,
    AbortSignal,
    document: {
      documentElement: root,
      querySelectorAll: () => Object.values(localized),
      querySelector: (selector: string) =>
        ({
          "#consent": consent,
          "#connect": button,
          "#connect-label": buttonLabel,
          "#connect-success": successIcon,
          "#status": status,
          "#login-state": loginState,
        })[selector as "#consent"],
    },
    chrome: {
      i18n: {
        getMessage: (key: string) => {
          if (input.missingMessages) return ""
          const locale = input.locale ?? "en"
          if (key === "@@ui_locale") return locale
          if (key === "@@bidi_dir") return "ltr"
          return (
            catalogs[locale]?.[key]?.message ??
            catalogs[locale.split("_")[0]]?.[key]?.message ??
            catalogs.en[key]?.message ??
            ""
          )
        },
      },
      tabs: { query: async () => [{ id: 10, url: input.url ?? `http://127.0.0.1:12345/#token=${token}` }] },
      cookies: {
        getAllCookieStores: async () =>
          input.stores ?? [
            { id: "other", tabIds: [9] },
            { id: "selected", tabIds: [10] },
          ],
        getAll: async (query: Record<string, unknown>) => {
          queries.push(query)
          return query.name === cookie.name ? (input.cookies ?? [cookie]) : []
        },
      },
    },
    fetch: async (url: string, init: Record<string, unknown>) => {
      requests.push({ url, init })
      await input.beforeResponse?.()
      if (input.networkFailure) throw new Error(`PRIVATE_NETWORK_ERROR ${token} ${cookie.value}`)
      const responseStatus = input.responseStatus ?? 200
      return {
        ok: responseStatus === 200,
        status: responseStatus,
        json: async () => ({
          phase: responseStatus === 200 ? "imported" : "failed",
          code: input.responseCode,
          importedCookies: 1,
          error: `PRIVATE_SERVER_ERROR ${cookie.value}`,
        }),
      }
    },
  })
  return {
    consent,
    button,
    buttonLabel,
    successIcon,
    status,
    loginState,
    queries,
    requests,
    localized,
    root,
    click: async () => {
      await handlers["button:click"]()
    },
    approve: () => {
      consent.checked = true
      handlers["consent:change"]()
    },
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  }
}

describe("ChatGPT session connector explicit approval", () => {
  test("all supported locales cover every UI, manifest and status message", async () => {
    expect(locales.sort()).toEqual(["de", "en", "es", "fr", "ja", "ko", "zh_CN", "zh_TW"])
    const keys = Object.keys(catalogs.en).sort()
    for (const locale of locales) {
      expect(Object.keys(catalogs[locale]).sort()).toEqual(keys)
      for (const entry of Object.values(catalogs[locale])) expect(entry.message.trim()).not.toBe("")
      const p = popup({ locale })
      for (const [key, node] of Object.entries(p.localized))
        expect(node.textContent).toBe(catalogs[locale][key].message)
      await p.settle()
      expect(p.loginState.textContent).toBe(catalogs[locale].statusSessionFound.message)
      expect(p.root.lang).toBe(locale.replaceAll("_", "-"))
      expect(p.root.dir).toBe("ltr")
      expect(p.button.disabled).toBe(true)
      expect(p.consent.checked).toBe(false)
      expect(p.queries).toHaveLength(candidateNames().length)
    }
  })

  test("regional and unsupported languages fall back without blank labels", () => {
    expect(popup({ locale: "fr_CA" }).localized.loginStatusLabel.textContent).toBe(catalogs.fr.loginStatusLabel.message)
    expect(popup({ locale: "xx_ZZ" }).localized.loginStatusLabel.textContent).toBe(catalogs.en.loginStatusLabel.message)
  })

  test("preserves visible English content when Chrome has no localized messages", async () => {
    const p = popup({ missingMessages: true })
    expect(p.localized.loginStatusLabel.textContent).toBe(catalogs.en.loginStatusLabel.message)
    expect(p.localized.consent.textContent).toBe(catalogs.en.consent.message)
    expect(p.localized.connect.textContent).toBe(catalogs.en.connect.message)
    expect(p.status.textContent).toBe(catalogs.en.statusApproval.message)
    await p.settle()
    expect(p.loginState.textContent).toBe("Session cookies found (login not yet verified)")
    p.approve()
    await p.click()
    expect(p.status.textContent).toBe(catalogs.en.statusImported.message)
  })

  test("Chinese approval, success and errors remain localized and never expose raw credentials", async () => {
    const success = popup({ locale: "zh_CN" })
    await success.settle()
    expect(success.loginState.textContent).toBe(catalogs.zh_CN.statusSessionFound.message)
    expect(success.status.textContent).toBe(catalogs.zh_CN.statusApproval.message)
    success.approve()
    await success.click()
    expect(success.status.textContent).toBe(catalogs.zh_CN.statusImported.message)
    expect(success.consent.checked).toBe(true)
    expect(success.consent.disabled).toBe(true)
    expect(success.button.dataset.state).toBe("imported")
    expect(success.buttonLabel.textContent).toBe(catalogs.zh_CN.connectImported.message)
    expect(success.successIcon.hidden).toBe(false)
    const profile = popup({ locale: "zh_CN", stores: [] })
    await profile.settle()
    expect(profile.loginState.textContent).toBe(catalogs.zh_CN.statusUnknown.message)
    profile.approve()
    await profile.click()
    expect(profile.status.textContent).toBe(catalogs.zh_CN.errorProfile.message)
    for (const [status, key] of [
      [400, "errorInvalidSession"],
      [403, "errorUnauthorized"],
      [409, "errorInUse"],
      [410, "errorExpired"],
      [500, "errorImport"],
    ] as const) {
      const p = popup({ locale: "zh_CN", responseStatus: status })
      await p.settle()
      p.approve()
      await p.click()
      expect(p.status.textContent).toBe(catalogs.zh_CN[key].message)
      expect(p.status.textContent).not.toContain(cookie.value)
      expect(p.status.textContent).not.toContain(token)
      expect(p.button.disabled).toBe(true)
    }
    const failed = popup({ locale: "zh_CN", networkFailure: true })
    await failed.settle()
    failed.approve()
    await failed.click()
    expect(failed.status.textContent).toBe(catalogs.zh_CN.errorImport.message)
  })
  test("shows login status without sending cookies before approval", async () => {
    const p = popup()
    await p.settle()
    expect(p.loginState.textContent).toBe(catalogs.en.statusSessionFound.message)
    expect(p.queries).toHaveLength(candidateNames().length)
    expect(p.requests).toHaveLength(0)
    await p.click()
    expect(p.queries).toHaveLength(candidateNames().length)
    expect(p.requests).toHaveLength(0)
  })
  test("busy and secure-storage rejection preserve localized actionable reasons without server secrets", async () => {
    for (const [code, status, key] of [
      ["login_import_busy", 409, "errorBusy"],
      ["credential_storage", 503, "errorStorage"],
      ["login_connection_expired", 410, "errorExpired"],
      ["login_expired", 503, "errorNoSession"],
      ["login_expired", 410, "errorExpired"],
    ] as const) {
      const p = popup({ locale: "zh_CN", responseStatus: status, responseCode: code })
      await p.settle()
      p.approve()
      await p.click()
      expect(p.status.textContent).toBe(catalogs.zh_CN[key].message)
      expect(p.status.textContent).not.toContain("PRIVATE_SERVER_ERROR")
      expect(p.status.textContent).not.toContain(cookie.value)
    }
  })
  test("shows not logged in when the active Chrome profile has no supported session", async () => {
    const p = popup({ cookies: [] })
    await p.settle()
    expect(p.loginState.textContent).toBe(catalogs.en.statusLoggedOut.message)
    expect(p.requests).toHaveLength(0)
  })
  test("requires a local OpenCode connection tab before reading cookies", async () => {
    const p = popup({ url: "https://chatgpt.com/" })
    await p.settle()
    const statusQueries = p.queries.length
    p.approve()
    await p.click()
    expect(p.queries).toHaveLength(statusQueries)
    expect(p.requests).toHaveLength(0)
    expect(p.status.textContent).toContain("127.0.0.1")
  })
  test("queries only named ChatGPT session cookies in the selected profile", async () => {
    const p = popup()
    await p.settle()
    p.queries.length = 0
    p.approve()
    await p.click()
    expect(p.queries).toHaveLength(66)
    expect(
      p.queries.every(
        (q) =>
          q.url === "https://chatgpt.com/" &&
          q.storeId === "selected" &&
          q.secure === true &&
          candidateNames().includes(q.name as string),
      ),
    ).toBe(true)
    expect(p.requests).toHaveLength(1)
    expect(p.requests[0].url).toBe("http://127.0.0.1:12345/import")
    expect(p.requests[0].init.credentials).toBe("omit")
    expect(p.requests[0].init.redirect).toBe("error")
    expect(p.status.textContent).not.toContain(cookie.value)
    expect(p.status.textContent).not.toContain(token)
    expect(p.consent.checked).toBe(true)
  })
  test("does not transfer Google, partitioned or weak cookies", async () => {
    const p = popup({
      cookies: [
        { ...cookie, domain: ".google.com" },
        { ...cookie, partitionKey: {} },
        { ...cookie, httpOnly: false },
      ],
    })
    await p.settle()
    p.approve()
    await p.click()
    expect(p.requests).toHaveLength(0)
    expect(p.status.textContent).toContain("No supported ChatGPT session")
  })
  test("successful import latches the checked consent and checkmarked button in every locale", async () => {
    for (const locale of locales) {
      const p = popup({ locale })
      await p.settle()
      p.approve()
      await p.click()
      expect(p.buttonLabel.textContent).toBe(catalogs[locale].connectImported.message)
      expect(p.status.textContent).toBe(catalogs[locale].statusImported.message)
      expect(p.successIcon.hidden).toBe(false)
      expect(p.button.disabled).toBe(true)
      expect(p.button.attributes["aria-busy"]).toBe("false")
      expect(p.consent.checked).toBe(true)
      expect(p.consent.disabled).toBe(true)
      await p.click()
      p.approve()
      await p.click()
      expect(p.requests).toHaveLength(1)
      expect(p.button.dataset.state).toBe("imported")
      expect(p.loginState.textContent).toBe(catalogs[locale].statusSessionFound.message)
    }
  })
  test("pending import shows progress, blocks double dispatch, then reveals success", async () => {
    let finish!: () => void
    const p = popup({
      beforeResponse: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    await p.settle()
    p.approve()
    const pending = p.click()
    await p.settle()
    expect(p.button.dataset.state).toBe("importing")
    expect(p.buttonLabel.textContent).toBe(catalogs.en.statusImporting.message)
    expect(p.button.attributes["aria-busy"]).toBe("true")
    expect(p.successIcon.hidden).toBe(true)
    expect(p.consent.disabled).toBe(true)
    await p.click()
    expect(p.requests).toHaveLength(1)
    finish()
    await pending
    expect(p.successIcon.hidden).toBe(false)
    expect(p.consent.checked).toBe(true)
  })
  test("failed import never shows a success check and requires explicit approval before retry", async () => {
    const p = popup({ networkFailure: true })
    await p.settle()
    p.approve()
    await p.click()
    expect(p.button.dataset.state).toBe("error")
    expect(p.successIcon.hidden).toBe(true)
    expect(p.buttonLabel.textContent).toBe(catalogs.en.connect.message)
    expect(p.consent.checked).toBe(false)
    expect(p.consent.disabled).toBe(false)
    expect(p.button.disabled).toBe(true)
    await p.click()
    expect(p.requests).toHaveLength(1)
    p.approve()
    expect(p.button.disabled).toBe(false)
    expect(p.status.textContent).not.toContain(cookie.value)
  })
  test("completed button remains full contrast despite being disabled", () => {
    const css = readFileSync(new URL("../../resources/gpt-pro-login/popup.css", import.meta.url), "utf8")
    expect(css).toContain('button[data-state="imported"]:disabled')
    expect(css).toContain("opacity: 1;")
    expect(markup).toContain('id="connect-success"')
    expect(markup).toContain('aria-live="polite">Import session')
  })
  test("manifest has no Google, storage, downloads or browsing-history permissions", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../resources/gpt-pro-login/manifest.json", import.meta.url), "utf8"),
    )
    expect(manifest.permissions).toEqual(["cookies", "activeTab"])
    expect(manifest.host_permissions).toEqual(["https://chatgpt.com/*", "http://127.0.0.1/*"])
    expect(manifest.content_scripts).toBeUndefined()
    expect(manifest.default_locale).toBe("en")
    for (const value of [manifest.name, manifest.description, manifest.action.default_title]) {
      const key = /^__MSG_(\w+)__$/.exec(value)?.[1]
      expect(key).toBeDefined()
      expect(catalogs.en[key!]?.message).toBeTruthy()
    }
  })
})
