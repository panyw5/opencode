export const SESSION_COOKIE_NAMES = ["__Secure-next-auth.session-token", "__Secure-authjs.session-token"]

/** @param {string} name */
export function sessionCookieFamily(name) {
  return SESSION_COOKIE_NAMES.find(
    (base) => name === base || new RegExp(`^${base.replaceAll(".", "\\.")}\\.(?:0|[1-9][0-9]?)$`).test(name),
  )
}

/** @param {string} value */
export function parseConnection(value) {
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search
  ) {
    throw new Error("Use the OpenCode connection page on 127.0.0.1.")
  }
  const token = new URLSearchParams(url.hash.slice(1)).get("token")
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new Error("Connection expired or invalid. Open a new connection from OpenCode.")
  return { origin: url.origin, token }
}

export function candidateNames() {
  return SESSION_COOKIE_NAMES.flatMap((base) => [base, ...Array.from({ length: 16 }, (_, i) => `${base}.${i}`)])
}
