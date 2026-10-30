import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { GPT_PRO_LOGIN_EXPIRED_DETAIL, readGptProAuthentication } from "./gpt-pro-authentication"

function sessionFixture(responses: Array<{ status: number; data?: unknown; error?: boolean; retryAfter?: string }>) {
  let calls = 0
  const logs: string[] = []
  const cdp = {
    evaluate: async <T>(expression: string) =>
      (await runInNewContext(expression, {
        location: { origin: "https://chatgpt.com" },
        AbortSignal,
        fetch: async () => {
          const response = responses[Math.min(calls++, responses.length - 1)]
          if (response.error) throw new Error("PRIVATE_FETCH_ERROR")
          return { status: response.status, ok: response.status === 200, headers: { get: () => response.retryAfter }, json: async () => response.data }
        },
      })) as T,
  }
  return { cdp, logs, calls: () => calls, read: () => readGptProAuthentication(cdp, (line) => logs.push(line)) }
}

test("authentication returns hashed identity metadata, never session credentials", async () => {
  const result = await readGptProAuthentication({
    evaluate: async <T>() =>
      ({
        phase: "authenticated",
        identity: "synthetic-user",
        account: "test@example.invalid",
        accessToken: "PRIVATE_TOKEN",
      }) as T,
  })
  expect(result.phase).toBe("authenticated")
  expect(result.accountID).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN")
  expect(JSON.stringify(result)).not.toContain("synthetic-user")
})
test("unknown authentication is never promoted from composer visibility", async () => {
  expect(
    await readGptProAuthentication({ evaluate: async <T>() => ({ phase: "unknown", composer: true }) as T }),
  ).toEqual({ phase: "unknown" })
  expect(await readGptProAuthentication({ evaluate: async <T>() => ({ phase: "needs_login" }) as T })).toEqual({
    phase: "needs_login",
  })
})

test("failed token refresh rejects the stale identity even with HTTP 200", async () => {
  const f = sessionFixture([
    {
      status: 200,
      data: { user: { id: "STALE_USER" }, accessToken: "PRIVATE_TOKEN", error: "RefreshAccessTokenError" },
    },
  ])
  expect(await f.read()).toEqual({ phase: "needs_login", detail: GPT_PRO_LOGIN_EXPIRED_DETAIL })
  expect(f.calls()).toBe(1)
  expect(f.logs.join("\n")).toContain("reason=refresh_failed status=200")
  expect(f.logs.join("\n")).not.toMatch(/STALE_USER|PRIVATE_TOKEN/)
})

test("expired sessions and other session errors never authenticate old user metadata", async () => {
  for (const extra of [{ expires: "2000-01-01T00:00:00Z" }, { error: "PRIVATE_SERVER_ERROR" }]) {
    const f = sessionFixture([{ status: 200, data: { user: { id: "old-user" }, ...extra } }])
    expect((await f.read()).phase).toBe("error" in extra ? "unknown" : "needs_login")
    expect(f.calls()).toBe(1)
    expect(f.logs.join("\n")).not.toContain("PRIVATE_SERVER_ERROR")
  }
})

test("transport performs one attempt; profile coordinator owns retry scheduling", async () => {
  const f = sessionFixture([{ status: 429 }, { status: 200, data: { user: { id: "current-user" } } }])
  expect((await f.read()).phase).toBe("unknown")
  expect(f.calls()).toBe(1)
})

test("transient network failures are bounded and cannot be treated as logout", async () => {
  const f = sessionFixture([{ status: 0, error: true }])
  expect(await f.read()).toEqual({ phase: "unknown" })
  expect(f.calls()).toBe(1)
  expect(f.logs.join("\n")).not.toContain("PRIVATE_FETCH_ERROR")
})

test("explicit logout and challenge responses do not trigger retry storms", async () => {
  for (const status of [401, 403]) {
    const f = sessionFixture([{ status }])
    expect((await f.read()).phase).toBe(status === 401 ? "needs_login" : "unknown")
    expect(f.calls()).toBe(1)
  }
})

test("transport preserves Retry-After without sleeping or retrying locally", async () => {
  const f = sessionFixture([{ status: 429, retryAfter: "120" }])
  expect(await f.read()).toEqual({ phase: "unknown", retryAfterMs: 120_000 })
  expect(f.calls()).toBe(1)
})

test("transport never caches identity; coalescing belongs to the profile coordinator", async () => {
  const f = sessionFixture([
    { status: 200, data: { user: { id: "first-user" } } },
    { status: 200, data: { user: { id: "second-user" } } },
  ])
  const [a, b] = await Promise.all([f.read(), f.read()])
  expect(a.accountID).not.toBe(b.accountID)
  expect(f.calls()).toBe(2)
  expect((await f.read()).accountID).not.toBe(a.accountID)
  expect(f.calls()).toBe(3)
})
