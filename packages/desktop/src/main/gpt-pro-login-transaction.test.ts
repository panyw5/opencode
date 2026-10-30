import { expect, test } from "bun:test"
import type { Cookie } from "electron"
import { GPT_PRO_PARTITION, GPT_PRO_URL } from "@opencode-ai/util/gpt-pro"
import { GptProCredentialProfiles } from "./gpt-pro-credential-profiles"
import { GptProLoginTransaction } from "./gpt-pro-login-transaction"
import { GptProSessionCoordinator } from "./gpt-pro-session-coordinator"
import type { SessionCookie } from "./gpt-pro-session-cookies"

const cookie: SessionCookie = {
  name: "__Secure-next-auth.session-token",
  value: "SYNTHETIC",
  domain: ".chatgpt.com",
  path: "/",
  secure: true,
  httpOnly: true,
  hostOnly: false,
  sameSite: "lax",
  session: true,
}
function fixture() {
  const jars = new Map<string, Cookie[]>()
  const views = [
    {
      pageID: "old-manual",
      partition: "old-manual",
      profileID: GPT_PRO_PARTITION,
      url: GPT_PRO_URL,
      title: "Old draft",
      loading: false,
      shared: false,
      epoch: 1,
      documentEpoch: 1,
      draft: "PRIVATE_MANUAL_DRAFT",
    },
  ]
  let valid = true
  let retryAfterMs: number | undefined
  let requests = 0
  let commitHook = () => {}
  let persisted: string[] = []
  const commits: string[] = []
  const browser = {
    getState: () => views,
    has: (id: string) => views.some((v) => v.pageID === id),
    openPage: async (id: string, profileID: string) => {
      views.push({ ...views[0], pageID: id, partition: id, profileID, title: "Candidate", draft: "" })
      return views.at(-1)!
    },
    cdp: (id: string) => ({
      evaluate: async <T>(expression: string) => {
        if (id === "old-manual") throw Error("The old page must not be inspected, refreshed or mutated")
        if (!expression.includes("/api/auth/session")) return { url: GPT_PRO_URL } as T
        requests++
        return (
          valid
            ? { phase: "authenticated", identity: "synthetic-user" }
            : retryAfterMs
              ? { phase: "unknown", retryAfterMs }
              : { phase: "needs_login" }
        ) as T
      },
    }),
  }
  const profiles = new GptProCredentialProfiles({
    create: (id) => {
      jars.set(id, [])
      return {
        cookies: {
          get: async () => jars.get(id)!,
          set: async (c) => {
            jars.get(id)!.push(c as Cookie)
          },
          remove: async () => {},
          flushStore: async () => {},
        },
        dispose: async () => {
          jars.delete(id)
        },
      }
    },
    persist: async (cookies) => {
      persisted = cookies.map((c) => c.value)
      commitHook()
    },
    changed: () => {},
    log: () => {},
  })
  jars.get(GPT_PRO_PARTITION)!.push({ ...cookie, value: "ORIGINAL" })
  const coordinators = new Map<string, GptProSessionCoordinator>()
  const service = new GptProLoginTransaction({
    browser: browser as never,
    credentials: {
      ready: async () => {},
      profileID: () => profiles.profileID(),
      stage: (cookies) => profiles.stage(cookies),
      promote: (id, action) => profiles.promote(id, action),
      collect: (retain) => profiles.collect(retain),
      retain: (id) => profiles.retain(id),
    },
    controller: {
      assertLoginAccount: () => {},
      importLogin: async (action) => action(),
      promoteLoginProfile: (id) => {
        commits.push(id)
      },
    },
    coordinator: (id) => {
      if (!coordinators.has(id)) coordinators.set(id, new GptProSessionCoordinator(browser, id))
      return coordinators.get(id)!
    },
    changed: () => {},
    log: () => {},
  })
  return {
    service,
    profiles,
    views,
    jars,
    commits,
    persisted: () => persisted,
    requests: () => requests,
    invalid: () => {
      valid = false
    },
    authenticate: () => {
      valid = true
    },
    backoff: () => {
      valid = false
      retryAfterMs = 60_000
    },
    beforeCommit: (hook: () => void) => {
      commitHook = hook
    },
  }
}
test("a verified candidate promotes without inspecting or touching an old manual draft", async () => {
  const f = fixture()
  await f.service.import([cookie])
  expect(f.profiles.profileID()).not.toBe(GPT_PRO_PARTITION)
  expect(f.views[0].draft).toBe("PRIVATE_MANUAL_DRAFT")
  expect(f.jars.get(GPT_PRO_PARTITION)![0].value).toBe("ORIGINAL")
  expect(f.commits).toEqual([f.profiles.profileID()])
  expect(f.service.pendingProfileID()).toBeUndefined()
  expect(f.requests()).toBe(1)
})
test("failed candidate authentication preserves the old vault and supports explicit verification of the same jar", async () => {
  const f = fixture()
  f.invalid()
  await expect(f.service.import([cookie])).rejects.toThrow("login_expired")
  const id = f.service.pendingProfileID()!
  expect(f.profiles.profileID()).toBe(GPT_PRO_PARTITION)
  expect(f.persisted()).toEqual([])
  expect(f.commits).toEqual([])
  f.authenticate()
  await f.service.verify()
  expect(f.profiles.profileID()).toBe(id)
  expect(f.requests()).toBe(2)
})
test("document replacement during encrypted commit rolls back and cannot migrate execution", async () => {
  const f = fixture()
  f.beforeCommit(() => {
    f.views.at(-1)!.documentEpoch++
  })
  await expect(f.service.import([cookie])).rejects.toThrow("page_changed")
  expect(f.commits).toEqual([])
  expect(f.profiles.profileID()).toBe(GPT_PRO_PARTITION)
  expect(f.persisted()).toEqual(["ORIGINAL"])
})
test("explicit verification cannot bypass a candidate Retry-After backoff", async () => {
  const f = fixture()
  f.backoff()
  await expect(f.service.import([cookie])).rejects.toThrow("login_import_pending")
  await expect(f.service.verify()).rejects.toThrow("backoff")
  expect(f.requests()).toBe(1)
})
