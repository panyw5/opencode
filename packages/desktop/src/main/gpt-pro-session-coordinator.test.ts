import { expect, test } from "bun:test"
import { GPT_PRO_PARTITION, GPT_PRO_URL } from "@opencode-ai/util/gpt-pro"
import { GptProSessionCoordinator } from "./gpt-pro-session-coordinator"
import type { ViewState } from "./browser"

function fixture() {
  const views: ViewState[] = ["valid", "login"].map((pageID) => ({
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
  let response: { phase: string; identity?: string; retryAfterMs?: number } = {
    phase: "authenticated",
    identity: "synthetic-user",
  }
  let pageMetadata = { url: GPT_PRO_URL, composer: false, verification: false }
  let time = 10_000
  let pause: Promise<void> | undefined
  let started!: () => void
  const networkStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  let inFlight = 0
  let maxInFlight = 0
  const browser = {
    getState: () => views,
    cdp: () => ({
      evaluate: async <T>(expression: string) => {
        if (!expression.includes("/api/auth/session")) {
          metadata++
          return pageMetadata as T
        }
        requests++
        maxInFlight = Math.max(maxInFlight, ++inFlight)
        started()
        try {
          await pause
          return response as T
        } finally {
          inFlight--
        }
      },
    }),
  }
  const coordinator = new GptProSessionCoordinator(
    browser,
    GPT_PRO_PARTITION,
    () => {},
    () => time,
  )
  return {
    browser,
    coordinator,
    views,
    requests: () => requests,
    metadata: () => metadata,
    maxInFlight: () => maxInFlight,
    networkStarted,
    advance: (ms: number) => {
      time += ms
    },
    challenge: () => {
      pageMetadata = { ...pageMetadata, verification: true }
    },
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
  await f.networkStarted
  f.views[0].documentEpoch!++
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
  await f.networkStarted
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
  expect(f.coordinator.snapshot().authentication.retryAt).toBe(11_000)
})

test("explicit credential revocation invalidates identity evidence without fetching or navigating", async () => {
  const f = fixture()
  await f.coordinator.verify()
  f.coordinator.credentialsChanged()
  expect(f.coordinator.snapshot().generation).toBe(1)
  expect(f.coordinator.snapshot().authentication.phase).toBe("unverified")
  expect(f.requests()).toBe(1)
})

test("different pages in one profile serialize requests and keep their own source documents", async () => {
  const f = fixture()
  f.views.push({ ...f.views[0], pageID: "second", partition: "second" })
  const [first, second] = await Promise.all([f.coordinator.verify("valid"), f.coordinator.verify("second")])
  expect(first.source?.pageID).toBe("valid")
  expect(second.source?.pageID).toBe("second")
  expect(f.requests()).toBe(2)
  expect(f.maxInFlight()).toBe(1)
})

test("candidate and active profiles never share authentication evidence or single-flight state", async () => {
  const f = fixture()
  const profile = `${GPT_PRO_PARTITION}-generation-synthetic`
  f.views.push({ ...f.views[0], profileID: profile, pageID: "candidate", partition: "candidate" })
  const candidate = new GptProSessionCoordinator(f.browser, profile)
  const [activeAuth, candidateAuth] = await Promise.all([f.coordinator.verify("valid"), candidate.verify("candidate")])
  expect(activeAuth.source?.pageID).toBe("valid")
  expect(candidateAuth.source?.pageID).toBe("candidate")
  expect(f.maxInFlight()).toBe(2)
  expect(() => f.coordinator.assertAuthentication(candidateAuth)).toThrow("page_changed")
  expect(() => candidate.assertAuthentication(activeAuth)).toThrow("page_changed")
  candidate.credentialsChanged()
  expect(f.coordinator.snapshot().generation).toBe(0)
  expect(f.coordinator.snapshot().authentication.phase).toBe("authenticated")
  candidate.dispose()
})

test("visible human verification stops implicit retries before any session request", async () => {
  const f = fixture()
  f.challenge()
  expect((await f.coordinator.verify()).phase).toBe("verification")
  for (let i = 0; i < 20; i++) expect((await f.coordinator.verify()).phase).toBe("verification")
  expect(f.metadata()).toBe(1)
  expect(f.requests()).toBe(0)
})

test("a source still loading cannot borrow another page's valid identity and must be explicitly verified after settling", async () => {
  const f = fixture()
  await f.coordinator.verify("valid")
  f.views.push({ ...f.views[0], pageID: "loading-consultation", partition: "loading-consultation", loading: true })
  expect((await f.coordinator.verify("loading-consultation")).phase).toBe("unverified")
  expect(f.requests()).toBe(1)
  expect(f.coordinator.snapshot().authentication.phase).toBe("authenticated")
  f.views.at(-1)!.loading = false
  const settled = await f.coordinator.verify("loading-consultation")
  expect(settled.phase).toBe("authenticated")
  expect(settled.source?.pageID).toBe("loading-consultation")
  expect(f.requests()).toBe(2)
})

test("Retry-After is shared across pages and explicit clock advance permits a fresh request", async () => {
  const f = fixture()
  f.views.push({ ...f.views[0], pageID: "second", partition: "second" })
  f.response({ phase: "unknown", retryAfterMs: 120_000 })
  expect((await f.coordinator.verify("valid")).retryAt).toBe(130_000)
  f.advance(119_999)
  await f.coordinator.verify("second")
  expect(f.requests()).toBe(1)
  f.advance(1)
  f.response({ phase: "authenticated", identity: "synthetic-user" })
  expect((await f.coordinator.verify("second")).phase).toBe("authenticated")
  expect(f.requests()).toBe(2)
})

test.each(["credential", "close", "document", "loading", "loop"])(
  "promotion rejects %s changes after successful authentication",
  async (change) => {
    const f = fixture()
    const evidence = await f.coordinator.verify("valid")
    expect(() => f.coordinator.assertAuthentication(evidence)).not.toThrow()
    if (change === "credential") f.coordinator.credentialsChanged()
    if (change === "close") f.views.splice(0, 1)
    if (change === "document") f.views[0].documentEpoch!++
    if (change === "loading") f.views[0].loading = true
    if (change === "loop") f.views[0].authRedirectLoop = true
    expect(() => f.coordinator.assertAuthentication(evidence)).toThrow("page_changed")
  },
)
