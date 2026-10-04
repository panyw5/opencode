import { sessionCookieFamily } from "../../resources/gpt-pro-login/common.js"
import type { Cookie, Cookies } from "electron"

export type SessionCookie = {
  name: string
  value: string
  domain: "chatgpt.com" | ".chatgpt.com"
  path: "/"
  secure: true
  httpOnly: true
  hostOnly: boolean
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict"
  session: boolean
  expirationDate?: number
}

const invalid = () => new Error("Only valid, unexpired ChatGPT login-session cookies can be imported.")

export function parseSessionCookies(input: unknown, nowSeconds = Date.now() / 1000): SessionCookie[] {
  if (!input || typeof input !== "object") throw invalid()
  const payload = input as { version?: unknown; cookies?: unknown }
  if (
    payload.version !== 1 ||
    !Array.isArray(payload.cookies) ||
    !payload.cookies.length ||
    payload.cookies.length > 32
  )
    throw invalid()
  const seen = new Set<string>()
  const cookies: SessionCookie[] = []
  for (const raw of payload.cookies) {
    if (!raw || typeof raw !== "object") throw invalid()
    const cookie = raw as Record<string, unknown>
    if (
      typeof cookie.name !== "string" ||
      !sessionCookieFamily(cookie.name) ||
      seen.has(cookie.name) ||
      typeof cookie.value !== "string" ||
      !cookie.value.length ||
      cookie.value.length > 8192 ||
      /[\x00-\x20\x7f;]/.test(cookie.value) ||
      !["chatgpt.com", ".chatgpt.com"].includes(String(cookie.domain)) ||
      cookie.path !== "/" ||
      cookie.secure !== true ||
      cookie.httpOnly !== true ||
      typeof cookie.hostOnly !== "boolean" ||
      (cookie.hostOnly && cookie.domain !== "chatgpt.com") ||
      cookie.partitionKey !== undefined ||
      !["unspecified", "no_restriction", "lax", "strict"].includes(String(cookie.sameSite)) ||
      typeof cookie.session !== "boolean" ||
      (cookie.expirationDate !== undefined &&
        (typeof cookie.expirationDate !== "number" ||
          !Number.isFinite(cookie.expirationDate) ||
          cookie.expirationDate <= nowSeconds)) ||
      (cookie.session ? cookie.expirationDate !== undefined : cookie.expirationDate === undefined)
    )
      throw invalid()
    seen.add(cookie.name)
    cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain as SessionCookie["domain"],
      path: "/",
      secure: true,
      httpOnly: true,
      hostOnly: cookie.hostOnly,
      sameSite: cookie.sameSite as SessionCookie["sameSite"],
      session: cookie.session,
      ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate as number }),
    })
  }
  for (const family of new Set(cookies.map((cookie) => sessionCookieFamily(cookie.name)!))) {
    const pieces = cookies.filter((cookie) => sessionCookieFamily(cookie.name) === family)
    if (pieces.some((cookie) => cookie.name === family)) {
      if (pieces.length !== 1) throw invalid()
      continue
    }
    const indices = pieces.map((cookie) => Number(cookie.name.slice(family.length + 1))).sort((a, b) => a - b)
    if (indices.some((value, index) => value !== index)) throw invalid()
  }
  return cookies
}

export type CookieJar = Pick<Cookies, "get" | "remove" | "set" | "flushStore">

export async function importSessionCookies(jar: CookieJar, cookies: SessionCookie[], log: (message: string) => void) {
  // Keep a bounded in-memory rollback snapshot; never serialize credentials.
  const old = (await jar.get({ domain: "chatgpt.com" })).filter(
    (cookie) =>
      cookie.domain && ["chatgpt.com", ".chatgpt.com"].includes(cookie.domain) && !!sessionCookieFamily(cookie.name),
  )
  if (old.length > 32) throw new Error("The previous dedicated-browser session is too large to replace safely.")
  const remove = async (items: Array<{ name: string; domain?: string; path?: string }>) => {
    for (const item of items) await jar.remove(`https://chatgpt.com${item.path ?? "/"}`, item.name)
  }
  const set = (cookie: Cookie | SessionCookie) =>
    jar.set({
      url: "https://chatgpt.com/",
      name: cookie.name,
      value: cookie.value,
      path: cookie.path ?? "/",
      secure: cookie.secure ?? true,
      httpOnly: cookie.httpOnly ?? true,
      sameSite: cookie.sameSite ?? "unspecified",
      ...(cookie.hostOnly || !cookie.domain ? {} : { domain: cookie.domain }),
      ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
    })
  log(`session-import validation passed count=${cookies.length}`)
  try {
    log(`session-import replacing previous session count=${old.length}`)
    await remove(old)
    for (const cookie of cookies) await set(cookie)
    await jar.flushStore()
    log(`session-import persisted count=${cookies.length}; page authentication remains unverified`)
  } catch {
    log("session-import write failed; rolling back without logging credential details")
    try {
      await remove(cookies)
      for (const cookie of old) await set(cookie)
      await jar.flushStore()
      log("session-import rollback completed")
    } catch {
      log("session-import rollback failed; dedicated profile requires manual login recovery")
      throw new Error(
        "Session import failed and rollback could not finish. The dedicated browser needs login recovery.",
      )
    }
    throw new Error("Session import failed. The previous dedicated-browser session was restored.")
  }
}
