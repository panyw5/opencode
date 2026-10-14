import { expect, test } from "bun:test"
import { readGptProAuthentication } from "./gpt-pro-authentication"

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
