import { expect, test } from "bun:test"
import { GPT_PRO_PARTITION, GPT_PRO_URL } from "@opencode-ai/util/gpt-pro"
import type { ViewState } from "./browser"
import { openGptProCandidatePage } from "./gpt-pro-page-manager"

const profileID = `${GPT_PRO_PARTITION}-generation-synthetic`
function fixture(existing = true) {
  const view: ViewState = {
    pageID: profileID,
    partition: profileID,
    profileID,
    epoch: 1,
    documentEpoch: 1,
    url: GPT_PRO_URL,
    title: "Candidate",
    loading: false,
    shared: false,
  }
  const views = existing ? [view] : []
  const calls: unknown[][] = []
  const entered = Promise.withResolvers<void>()
  const loaded = Promise.withResolvers<void>()
  const browser = {
    getState: () => structuredClone(views),
    has: (id: string) => views.some((v) => v.pageID === id),
    openPage: async (...args: unknown[]) => {
      calls.push(["open", ...args])
      views.push(view)
      return view
    },
    cdp: () => ({
      waitForDocument: async () => {
        calls.push(["wait"])
        entered.resolve()
        await loaded.promise
        view.loading = false
      },
    }),
  }
  return { view, views, browser: browser as never, calls, entered: entered.promise, release: loaded.resolve }
}

test("new candidates use their own identity and explicit navigation reason", async () => {
  const f = fixture(false)
  await openGptProCandidatePage(f.browser, profileID, () => {})
  expect(f.calls).toEqual([["open", profileID, profileID, GPT_PRO_URL, { kind: "login" }, "login_candidate"]])
})
test("revisiting an existing candidate never reloads, navigates or inspects its manual content", async () => {
  const f = fixture()
  await openGptProCandidatePage(f.browser, profileID, () => {})
  expect(f.calls).toEqual([])
})
test("candidate open is a loading barrier, not fire-and-forget refresh", async () => {
  const f = fixture()
  f.view.loading = true
  let settled = false
  const opening = openGptProCandidatePage(f.browser, profileID, () => {}).then(() => {
    settled = true
  })
  await f.entered
  expect(settled).toBe(false)
  f.release()
  await opening
  expect(f.calls).toEqual([["wait"]])
})
test.each(["close", "epoch", "profile"])(
  "candidate %s during loading cannot authorize verification",
  async (change) => {
    const f = fixture()
    f.view.loading = true
    const opening = openGptProCandidatePage(f.browser, profileID, () => {})
    await f.entered
    if (change === "close") f.views.length = 0
    if (change === "epoch") f.view.epoch++
    if (change === "profile") f.view.profileID = GPT_PRO_PARTITION
    f.release()
    await expect(opening).rejects.toThrow("changed while awaiting")
  },
)
