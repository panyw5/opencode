import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, createSdkForServer } from "./server"
import { UI_LOCALE_HEADER } from "@opencode-ai/core/locale"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("SDK UI locale", () => {
  test("reads the current setting for every request and preserves auth headers", async () => {
    let locale = "zh"
    const headers: Headers[] = []
    const client = createSdkForServer({
      server: { url: "http://localhost:4096", password: "secret" },
      locale: () => locale,
      fetch: (async (request: Request) => {
        headers.push(new Headers(request.headers))
        return new Response(null, { status: 204 })
      }) as typeof fetch,
    })
    await client.session.promptAsync({ sessionID: "ses_test", parts: [{ type: "text", text: "original 约定" }] })
    locale = "ja"
    await client.session.promptAsync({ sessionID: "ses_test", parts: [{ type: "text", text: "original 约定" }] })
    expect(headers.map((item) => item.get(UI_LOCALE_HEADER))).toEqual(["zh", "ja"])
    expect(headers.every((item) => item.get("Authorization") === `Basic ${btoa("opencode:secret")}`)).toBe(true)
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})
