import { describe, expect, test } from "bun:test"
import { GptProDriver } from "./gpt-pro-driver"
import { GptProPageError } from "./gpt-pro-page-error"
import { GPT_PRO_PARTITION, GPT_PRO_URL, type GptProPageState } from "@opencode-ai/util/gpt-pro"

function fixture() {
  const page: GptProPageState = {
    url: GPT_PRO_URL,
    model: "GPT-6 Pro",
    targetModel: true,
    composer: true,
    draft: "Question",
    generating: false,
    revision: 0,
    users: [],
    sendReady: true,
  }
  const clicks: string[] = [],
    logs: string[] = []
  const opened: string[] = []
  let response: (data: { origin: string; path: string; status: number }) => void = () => {}
  let reads = 0
  let hidden = false
  let focuses = 0
  const cdp = {
    evaluate: async () => {
      reads++
      return structuredClone(page)
    },
    clickSelector: async (selector: string) => {
      clicks.push(selector)
    },
    pressEnter: async () => {
      throw Error("Blind Enter submission is forbidden")
    },
    onResponse: async (listener: typeof response) => {
      response = listener
      return () => {}
    },
    focus: async () => {
      focuses++
    },
  }
  const browser = {
    cdp: () => cdp,
    has: () => !hidden,
    getState: () => (hidden ? [] : [{ partition: GPT_PRO_PARTITION, url: page.url }]),
    open: async (_partition: string, url: string) => {
      opened.push(url)
      hidden = false
      page.url = url
    },
    present: () => {},
  }
  const driver = new GptProDriver(browser as never, (line) => logs.push(line))
  return {
    driver,
    page,
    clicks,
    logs,
    opened,
    reads: () => reads,
    focuses: () => focuses,
    hide: () => {
      hidden = true
    },
    respond: (status: number, path = "/backend-api/f/conversation") =>
      response({ origin: "https://chatgpt.com", path, status }),
  }
}

describe("gpt-pro trusted submission", () => {
  test("focuses the browser without typing, clearing or sending the draft", async () => {
    const f = fixture()
    await f.driver.focus()
    expect(f.focuses()).toBe(1)
    expect(f.page.draft).toBe("Question")
    expect(f.clicks).toHaveLength(0)
  })
  test("does not replace a manually generating conversation", async () => {
    const f = fixture()
    f.page.draft = ""
    f.page.generating = true
    await expect(f.driver.open(undefined, true)).rejects.toThrow("will not be interrupted")
    expect(f.opened).toHaveLength(0)
    expect(f.clicks).toHaveLength(0)
  })
  test("allows the website's automatic verification to finish without dispatching input", async () => {
    const f = fixture()
    f.page.composer = false
    f.page.error = { kind: "verification", message: "Browser verification required" }
    const waiting = f.driver.ready()
    await new Promise((resolve) => setTimeout(resolve, 20))
    f.page.error = undefined
    f.page.composer = true
    expect((await waiting).composer).toBe(true)
    expect(f.clicks).toHaveLength(0)
    expect(f.logs.join("\n")).toContain("automatic browser verification")
  })
  test("clicks the enabled send control exactly once, never presses Enter", async () => {
    const f = fixture()
    await f.driver.submit()
    expect(f.clicks).toHaveLength(1)
    expect(f.clicks[0]).toContain('button[aria-label="Send prompt"]:not(:disabled)')
    expect(f.logs.join("\n")).toContain("one trusted")
  })
  test("waits for the disabled send control rather than submitting prematurely", async () => {
    const f = fixture()
    f.page.sendReady = false
    const sending = f.driver.submit()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.clicks).toHaveLength(0)
    f.page.sendReady = true
    await sending
    expect(f.clicks).toHaveLength(1)
  })
  test("a visible website error prevents submission", async () => {
    const f = fixture()
    f.page.error = { kind: "request", message: "ChatGPT request failed" }
    await expect(f.driver.submit()).rejects.toBeInstanceOf(GptProPageError)
    expect(f.clicks).toHaveLength(0)
  })
  test("a model change before clicking send blocks submission", async () => {
    const f = fixture()
    f.page.model = "GPT-5.5 Pro"
    f.page.targetModel = false
    await expect(f.driver.submit()).rejects.toBeInstanceOf(GptProPageError)
    expect(f.clicks).toHaveLength(0)
  })
  test("tracks only relevant rejected requests without credential data", async () => {
    const f = fixture()
    await f.driver.ready()
    f.respond(403, "/backend-api/unrelated")
    expect((await f.driver.page()).error).toBeUndefined()
    f.respond(403)
    expect((await f.driver.page()).error?.message).toContain("403")
    expect(f.logs.join("\n")).toContain("no headers or body recorded")
  })
  test("a closed browser can be stopped without trying to read an orphan page", async () => {
    const f = fixture()
    f.hide()
    await f.driver.stop()
    expect(f.reads()).toBe(0)
    expect(f.clicks).toHaveLength(0)
  })
  test("reopens a closed consultation at its original URL without resubmitting", async () => {
    const f = fixture()
    f.hide()
    await f.driver.show(`${GPT_PRO_URL}c/existing`)
    expect(f.opened).toEqual([`${GPT_PRO_URL}c/existing`])
    expect(f.clicks).toHaveLength(0)
    expect(f.logs.join("\n")).toContain("without resubmitting")
  })
})
