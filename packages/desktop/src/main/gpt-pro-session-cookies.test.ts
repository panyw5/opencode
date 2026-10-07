import { describe, expect, test } from "bun:test"
import { parseSessionCookies, importSessionCookies, type CookieJar } from "./gpt-pro-session-cookies"
import { candidateNames, parseConnection } from "../../resources/gpt-pro-login/common.js"

const cookie = {
  name: "__Secure-next-auth.session-token",
  value: "synthetic-session-value",
  domain: ".chatgpt.com",
  path: "/",
  secure: true,
  httpOnly: true,
  hostOnly: false,
  sameSite: "lax",
  session: false,
  expirationDate: 9000,
}
const payload = (cookies: unknown[] = [cookie]) => ({ version: 1, cookies })

describe("ChatGPT session import scope", () => {
  test("accepts only the supported ChatGPT session", () => {
    const parsed = parseSessionCookies(payload(), 1000)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].httpOnly).toBe(true)
  })
  test("rejects Google, auth-domain, lookalike and subdomain cookies", () => {
    for (const domain of [
      ".google.com",
      "accounts.google.com",
      ".openai.com",
      "auth.openai.com",
      "chatgpt.com.evil.test",
      "sub.chatgpt.com",
    ]) {
      expect(() => parseSessionCookies(payload([{ ...cookie, domain }]), 1000)).toThrow()
    }
  })
  test("rejects unrelated ChatGPT cookies including bot clearance", () => {
    for (const name of ["SID", "cf_clearance", "__cf_bm", "oai-did", "__Host-next-auth.csrf-token"]) {
      expect(() => parseSessionCookies(payload([{ ...cookie, name }]), 1000)).toThrow()
    }
  })
  test("rejects expired, weak, partitioned, malformed and duplicate cookies", () => {
    for (const change of [
      { expirationDate: 999 },
      { secure: false },
      { httpOnly: false },
      { path: "/account" },
      { hostOnly: true },
      { partitionKey: {} },
      { sameSite: "unknown" },
      { value: "bad;value" },
      { session: true },
      { value: "" },
    ]) {
      expect(() => parseSessionCookies(payload([{ ...cookie, ...change }]), 1000)).toThrow()
    }
    expect(() => parseSessionCookies(payload([cookie, cookie]), 1000)).toThrow()
  })
  test("accepts a contiguous chunked token but refuses missing chunks or mixed whole tokens", () => {
    const chunks = [0, 1].map((i) => ({ ...cookie, name: `${cookie.name}.${i}` }))
    expect(parseSessionCookies(payload(chunks), 1000)).toHaveLength(2)
    expect(() => parseSessionCookies(payload([chunks[1]]), 1000)).toThrow()
    expect(() => parseSessionCookies(payload([chunks[0], cookie]), 1000)).toThrow()
  })
  test("supports host-only session cookies without inventing an expiration", () => {
    const { expirationDate, ...session } = cookie
    expect(
      parseSessionCookies(payload([{ ...session, domain: "chatgpt.com", hostOnly: true, session: true }]), 1000)[0]
        .expirationDate,
    ).toBeUndefined()
  })
  test("error messages never include submitted credential values", () => {
    try {
      parseSessionCookies(payload([{ ...cookie, domain: "google.com", value: "PRIVATE_VALUE" }]), 1000)
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_VALUE")
    }
  })
  test("extension candidates include no Google cookies", () => {
    expect(candidateNames()).toHaveLength(34)
    expect(candidateNames().every((name) => name.includes("session-token"))).toBe(true)
  })
  test("connection URLs must be local, unambiguous and have a full one-time token", () => {
    const token = "a".repeat(64)
    expect(parseConnection(`http://127.0.0.1:12345/#token=${token}`).origin).toBe("http://127.0.0.1:12345")
    for (const url of [
      `https://example.com/#token=${token}`,
      `http://localhost:12345/#token=${token}`,
      `http://127.0.0.1:12345/other#token=${token}`,
      `http://user:pass@127.0.0.1:12345/#token=${token}`,
      "http://127.0.0.1:12345/#token=short",
    ]) {
      expect(() => parseConnection(url)).toThrow()
    }
  })
})

function jarFixture(failAt = -1) {
  const operations: string[] = []
  let writes = 0
  let contents = [{ ...cookie, value: "old-session-value" }]
  const jar: CookieJar = {
    get: async () => [...contents],
    remove: async (_url, name) => {
      operations.push(`remove:${name}`)
      contents = contents.filter((item) => item.name !== name)
    },
    set: async (item) => {
      operations.push(`set:${item.name}`)
      if (writes++ === failAt) throw new Error(`PRIVATE_ERROR_${item.value}`)
      contents = [...contents.filter((old) => old.name !== item.name), { ...cookie, ...item }]
    },
    flushStore: async () => {
      operations.push("flush")
    },
  }
  const logs: string[] = []
  return { jar, operations, logs, contents: () => contents }
}

describe("dedicated session replacement", () => {
  test("persists the replacement without logging values", async () => {
    const f = jarFixture()
    await importSessionCookies(f.jar, parseSessionCookies(payload(), 1000), (line) => f.logs.push(line))
    expect(f.contents()[0].value).toBe(cookie.value)
    expect(f.operations.at(-1)).toBe("flush")
    expect(f.logs.join("\n")).not.toContain(cookie.value)
  })
  test("restores the previous session after a failed cookie write", async () => {
    const f = jarFixture(0)
    await expect(
      importSessionCookies(f.jar, parseSessionCookies(payload(), 1000), (line) => f.logs.push(line)),
    ).rejects.toThrow("restored")
    expect(f.contents()[0].value).toBe("old-session-value")
    expect(f.logs.join("\n")).not.toContain("PRIVATE_ERROR")
    expect(f.logs.join("\n")).not.toContain(cookie.value)
  })
})
