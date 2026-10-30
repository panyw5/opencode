import { expect, test } from "bun:test"
import { GPT_PRO_PARTITION, GPT_PRO_URL } from "@opencode-ai/util/gpt-pro"
import { GptProProbe } from "./gpt-pro-probe"

function fixture(existing = true) {
  const views = existing
    ? [
        {
          pageID: GPT_PRO_PARTITION,
          partition: GPT_PRO_PARTITION,
          profileID: GPT_PRO_PARTITION,
          url: GPT_PRO_URL,
          title: "Synthetic",
          epoch: 1,
          documentEpoch: 1,
          loading: false,
          shared: false,
        },
      ]
    : []
  let requests = 0
  let metadata = 0
  let diagnostics = 0
  let opens = 0
  let presented = 0
  const browser = {
    getState: () => views,
    has: () => !!views.length,
    open: async () => {
      throw Error("Explicit page identity required")
    },
    openPage: async () => {
      opens++
      const v = {
        pageID: GPT_PRO_PARTITION,
        partition: GPT_PRO_PARTITION,
        profileID: GPT_PRO_PARTITION,
        url: GPT_PRO_URL,
        title: "Synthetic",
        epoch: 1,
        documentEpoch: 1,
        loading: false,
        shared: false,
      }
      views.push(v)
      return v
    },
    present: () => {
      presented++
    },
    cdp: () => ({
      evaluate: async <T>(expression: string) => {
        if (expression.includes("/api/auth/session")) {
          requests++
          return { phase: "authenticated", identity: "synthetic" } as T
        }
        if (expression.includes("cloneNode")) {
          diagnostics++
          return { url: GPT_PRO_URL, draft: "MANUAL_PRIVATE_DRAFT", users: [] } as T
        }
        metadata++
        return { url: GPT_PRO_URL, composer: true, model: "Pro" } as T
      },
    }),
  }
  return {
    probe: new GptProProbe(browser),
    views,
    counts: () => ({ requests, metadata, diagnostics, opens, presented }),
  }
}
test("status is a pure canonical snapshot even when a page exists", async () => {
  const f = fixture()
  for (let i = 0; i < 100; i++) expect((await f.probe.status()).session.authentication.phase).toBe("unverified")
  expect(f.counts()).toEqual({ requests: 0, metadata: 0, diagnostics: 0, opens: 0, presented: 0 })
})
test("explicit open verifies once without navigating or reading an existing draft", async () => {
  const f = fixture()
  expect((await f.probe.open()).session.authentication.phase).toBe("authenticated")
  expect(f.counts()).toEqual({ requests: 1, metadata: 1, diagnostics: 0, opens: 0, presented: 1 })
  expect((await f.probe.status()).session.page.model).toBe("Pro")
})
test("closed status never recreates a page; explicit open may create one", async () => {
  const f = fixture(false)
  expect((await f.probe.status()).session.page.phase).toBe("not_open")
  expect(f.counts().opens).toBe(0)
  await f.probe.open()
  expect(f.counts().opens).toBe(1)
})
test("expensive diagnostic inspection is opt-in and never authenticates", async () => {
  const f = fixture()
  expect((await f.probe.inspect())?.draft).toBe("MANUAL_PRIVATE_DRAFT")
  expect(f.counts().diagnostics).toBe(1)
  expect(f.counts().requests).toBe(0)
  expect((await f.probe.status()).session.authentication.phase).toBe("unverified")
})
test("login location and navigation anomalies do not manufacture expired-session evidence", async () => {
  const f = fixture()
  f.views[0].url = `${GPT_PRO_URL}auth/login`
  const status = await f.probe.status()
  expect(status.session.page.location).toBe("login")
  expect(status.session.authentication.phase).toBe("unverified")
  expect(f.counts().requests).toBe(0)
})
