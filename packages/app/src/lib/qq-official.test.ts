import { describe, expect, test } from "bun:test"
import { probeQQ } from "./qq-official"

describe("qq official probe", () => {
  test("exchanges credentials and discovers gateway", async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith("getAppAccessToken")) return Response.json({ access_token: "token", expires_in: 7200 })
      return Response.json({ url: "wss://gateway.example.test" })
    }) as typeof fetch
    try {
      await expect(probeQQ("app", "secret", "https://api.example.test")).resolves.toEqual({
        accessToken: "token",
        gatewayUrl: "wss://gateway.example.test",
      })
      expect(requests).toEqual(["https://bots.qq.com/app/getAppAccessToken", "https://api.example.test/gateway"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
