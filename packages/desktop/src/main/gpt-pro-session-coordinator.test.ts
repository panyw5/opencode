import { expect, test } from "bun:test"
import { GPT_PRO_PARTITION, GPT_PRO_URL } from "@opencode-ai/util/gpt-pro"
import { GptProSessionCoordinator } from "./gpt-pro-session-coordinator"

function fixture() {
  const views = ["valid", "login"].map((pageID) => ({
    pageID,
    partition: pageID,
    profileID: GPT_PRO_PARTITION,
    epoch: 1,
    documentEpoch: 1,
    url: pageID === "valid" ? GPT_PRO_URL : `${GPT_PRO_URL}auth/login`,
    title: "ChatGPT",
    loading: false,
    shared: false,
  }))
  let requests = 0
  let metadata = 0
  let response = { phase: "authenticated", identity: "synthetic-user" }
  let pause: Promise<void> | undefined
  const browser = {
    getState: () => views,
    cdp: () => ({
      evaluate: async <T>(expression: string) => {
        if (!expression.includes("/api/auth/session")) {
          metadata++
          return { url: GPT_PRO_URL, composer: false } as T
        }
        requests++
        await pause
        return response as T
      },
    }),
  }
  const coordinator = new GptProSessionCoordinator(browser, GPT_PRO_PARTITION)
  return {
    coordinator,
    views,
    requests: () => requests,
    metadata: () => metadata,
    response: (value: typeof response) => {
      response = value
    },
    pause: (value: Promise<void>) => {
      pause = value
    },
  }
}

test("snapshot is pure, bounded and does not authenticate or inspect", () => {
  const f = fixture()
  for (let i = 0; i < 100; i++) expect(f.coordinator.snapshot().authentication.phase).toBe("unverified")
  expect(f.requests()).toBe(0)
  expect(f.metadata()).toBe(0)
})

test("authentication is independent of page ordering and composer visibility", async () => {
  for (const reverse of [false, true]) {
    const f = fixture()
    if (reverse) f.views.reverse()
    expect((await f.coordinator.verify()).phase).toBe("authenticated")
    expect(f.requests()).toBe(1)
  }
})

test("profile single-flight spans different CDP wrapper objects; dispatch checks do not use a TTL", async () => {
  const f = fixture()
  const results = await Promise.all(Array.from({ length: 12 }, () => f.coordinator.verify("valid")))
  expect(results.every((result) => result.phase === "authenticated")).toBe(true)
  expect(f.requests()).toBe(1)
  await f.coordinator.verify("valid")
  expect(f.requests()).toBe(2)
})

test("same-URL document refresh discards in-flight identity", async () => {
  const f = fixture()
  let release!: () => void
  f.pause(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const pending = f.coordinator.verify("valid")
  await Promise.resolve()
  f.views[0].documentEpoch++
  release()
  expect((await pending).phase).toBe("unverified")
  expect(f.coordinator.snapshot().authentication.accountID).toBeUndefined()
  expect(f.coordinator.snapshot().authentication.phase).toBe("unverified")
})

test("invalid login stops automatic authentication retries", async () => {
  const f = fixture()
  f.response({ phase: "needs_login", identity: "" })
  expect((await f.coordinator.verify()).phase).toBe("invalid")
  for (let i = 0; i < 10; i++) await f.coordinator.verify()
  expect(f.requests()).toBe(1)
})

test("import gates all profile authentication including settings and waits for old requests", async () => {
  const f = fixture()
  let release!: () => void
  f.pause(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const pending = f.coordinator.verify()
  for (let i = 0; i < 4; i++) await Promise.resolve()
  let installed = false
  const importing = f.coordinator.importCredentials(async () => {
    installed = true
  })
  expect((await f.coordinator.verify()).phase).toBe("unverified")
  expect(installed).toBe(false)
  release()
  expect((await pending).phase).toBe("unverified")
  await importing
  expect(installed).toBe(true)
  expect(f.requests()).toBe(1)
  expect(f.coordinator.snapshot().import.phase).toBe("pending_verification")
})

test("import revokes an authentication check queued before its first metadata read", async () => {
  const f = fixture()
  const pending = f.coordinator.verify()
  await f.coordinator.importCredentials(async () => {})
  expect((await pending).phase).toBe("unverified")
  expect(f.requests()).toBe(0)
  expect(f.metadata()).toBe(0)
  expect(f.coordinator.snapshot().authentication.phase).toBe("unverified")
})

test("verified import retains the profile gate through authentication, not just reload dispatch", async () => {
  const f = fixture()
  let installed!: () => void
  const accepted = new Promise<void>((resolve) => {
    installed = resolve
  })
  let release!: () => void
  f.pause(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const importing = f.coordinator.importCredentials(async () => {
    installed()
  }, true)
  await accepted
  await Promise.resolve()
  expect((await f.coordinator.verify()).phase).toBe("unverified")
  release()
  await importing
  expect(f.coordinator.snapshot().import.phase).toBe("verified")
  expect(f.requests()).toBe(1)
})

test("transient failures back off per profile without erasing credentials or scheduling timers", async () => {
  const f = fixture()
  f.response({ phase: "unknown", identity: "" })
  expect((await f.coordinator.verify()).phase).toBe("transient")
  for (let i = 0; i < 20; i++) await f.coordinator.verify()
  expect(f.requests()).toBe(1)
  expect(f.coordinator.snapshot().authentication.retryAt).toBeGreaterThan(Date.now())
})

test("explicit credential revocation invalidates identity evidence without fetching or navigating", async () => {
  const f = fixture()
  await f.coordinator.verify()
  f.coordinator.credentialsChanged()
  expect(f.coordinator.snapshot().generation).toBe(1)
  expect(f.coordinator.snapshot().authentication.phase).toBe("unverified")
  expect(f.requests()).toBe(1)
})
