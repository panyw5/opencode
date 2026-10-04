import { describe, expect, test } from "bun:test"
import {
  GPT_PRO_PARTITION,
  GPT_PRO_URL,
  isGpt6ProLabel,
  isGptProOrigin,
  type GptProPageState,
} from "@opencode-ai/util/gpt-pro"
import { GptProProbe } from "./gpt-pro-probe"

const page: GptProPageState = {
  url: GPT_PRO_URL,
  model: "GPT-6 Pro",
  targetModel: true,
  composer: true,
  draft: "",
  generating: false,
  revision: 0,
  users: [],
}

function fixture(input: { existing?: boolean; loading?: boolean; url?: string; page?: GptProPageState } = {}) {
  let existing = input.existing ?? true
  const opened: Array<{ partition: string; url: string }> = []
  const evaluated: string[] = []
  const presented: string[] = []
  const view = {
    partition: GPT_PRO_PARTITION,
    url: input.url ?? GPT_PRO_URL,
    title: "ChatGPT",
    loading: input.loading ?? false,
    shared: false,
    epoch: 1,
  }
  const browser = {
    has: () => existing,
    open: async (partition: string, url: string) => {
      opened.push({ partition, url })
      existing = true
      return view
    },
    getState: () => (existing ? [view] : []),
    cdp: () => ({
      evaluate: async <T>(expression: string) => {
        evaluated.push(expression)
        return (input.page ?? page) as T
      },
    }),
    present: (partition: string) => {
      presented.push(partition)
    },
  }
  const logs: string[] = []
  return { probe: new GptProProbe(browser, (line) => logs.push(line)), opened, evaluated, presented, logs }
}

describe("gpt-pro P0 diagnostics", () => {
  test("requires GPT-6 Pro, not another Pro model or plain GPT-6", () => {
    expect(isGpt6ProLabel("GPT-6 Pro")).toBe(true)
    expect(isGpt6ProLabel("GPT 6 Pro")).toBe(true)
    for (const label of ["GPT-5.5 Pro", "GPT-6", "GPT-6.1 Pro", "Pro", "GPT-60 Pro"])
      expect(isGpt6ProLabel(label)).toBe(false)
  })

  test("rejects lookalike hosts and non-HTTPS origins", () => {
    expect(isGptProOrigin("https://chatgpt.com/c/123")).toBe(true)
    for (const url of ["http://chatgpt.com", "https://chatgpt.com.example.com", "https://auth.openai.com", "garbage"])
      expect(isGptProOrigin(url)).toBe(false)
  })

  test("opens only the dedicated persistent profile", async () => {
    const f = fixture({ existing: false })
    expect((await f.probe.status()).phase).toBe("not_open")
    expect((await f.probe.open()).phase).toBe("ready")
    expect(f.opened).toEqual([{ partition: GPT_PRO_PARTITION, url: GPT_PRO_URL }])
    expect(f.presented).toEqual([GPT_PRO_PARTITION])
  })

  test("does not navigate an existing conversation or erase its draft", async () => {
    const f = fixture({ page: { ...page, draft: "unsent question", url: `${GPT_PRO_URL}c/existing` } })
    expect((await f.probe.open()).page?.draft).toBe("unsent question")
    expect(f.opened).toHaveLength(0)
  })

  test("does not evaluate an authentication or verification origin", async () => {
    const f = fixture({ url: "https://auth.openai.com/login" })
    expect((await f.probe.status()).phase).toBe("needs_login")
    expect(f.evaluated).toHaveLength(0)
  })

  test("waits for navigation to finish", async () => {
    const f = fixture({ loading: true })
    expect((await f.probe.status()).phase).toBe("loading")
    expect(f.evaluated).toHaveLength(0)
  })
  test("does not label a composer as ready when the website shows a request error", async () => {
    const f = fixture({ page: { ...page, error: { kind: "request", message: "ChatGPT request rejected" } } })
    const status = await f.probe.status()
    expect(status.phase).toBe("blocked")
    expect(status.detail).toContain("rejected")
  })
  test("reports browser verification without attempting login or sending", async () => {
    const f = fixture({
      page: { ...page, composer: false, error: { kind: "verification", message: "Browser verification required" } },
    })
    expect((await f.probe.status()).phase).toBe("needs_login")
    expect(f.opened).toHaveLength(0)
  })

  test("blocks wrong model without sending or switching channels", async () => {
    const f = fixture({ page: { ...page, model: "GPT-5.5 Pro", targetModel: false } })
    expect((await f.probe.status()).phase).toBe("needs_model")
    expect(f.opened).toHaveLength(0)
    expect(f.evaluated).toHaveLength(1)
  })

  test("tracks generating pages and keeps prompt/answer out of diagnostic logs", async () => {
    const f = fixture({
      page: {
        ...page,
        generating: true,
        users: [{ id: "user", text: "secret prompt" }],
        answer: {
          id: "answer",
          userID: "user",
          text: "secret answer",
          html: "<p>secret answer</p>",
          complete: false,
          truncated: false,
        },
      },
    })
    expect((await f.probe.status()).phase).toBe("tracking")
    expect(f.logs.join("\n")).not.toContain("secret")
  })

  test("rejects a page that changes origin during inspection", async () => {
    const f = fixture({ page: { ...page, url: "https://example.com/" } })
    expect((await f.probe.status()).phase).toBe("blocked")
  })
})
