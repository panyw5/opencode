import { describe, expect, test } from "bun:test"
import { GptProDriver } from "./gpt-pro-driver"
import { GptProPageError } from "./gpt-pro-page-error"
import { GPT_PRO_PARTITION, GPT_PRO_URL, type GptProPageState } from "@opencode-ai/util/gpt-pro"
import {
  CHATGPT_INSPECT_EXPRESSION,
  CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION,
  CHATGPT_ONBOARDING_DISMISS_EXPRESSION,
} from "@opencode-ai/util/chatgpt-page"

function fixture(options: {
  imageEvidence?: {
    url: string
    composer: Array<{ name: string; kind: "image"; sha256?: string; status: "ready" | "unknown" }>
    users: Array<{
      id?: string
      attachments: Array<{ name: string; kind: "image"; sha256?: string; status: "ready" | "unknown" }>
    }>
  }
  pendingUpload?: boolean
} = {}) {
  const page: GptProPageState = {
    url: GPT_PRO_URL,
    model: "GPT-6 Pro",
    targetModel: true,
    composer: true,
    draft: "Question",
    generating: false,
    revision: 0,
    users: [],
    attachmentInput: true,
    sendReady: true,
  }
  const clicks: string[] = [],
    logs: string[] = []
  const opened: string[] = []
  let response: (data: { origin: string; path: string; status: number }) => void = () => {}
  let reads = 0
  let hidden = false
  let focuses = 0
  let pickerOpen = false
  let selectSteps = 0
  let rightPresses = 0
  let overlay: { heading: string; selector: string } | null = null
  let covered = false
  const inserted: string[] = []
  const uploads: string[][] = []
  let insert = (text: string) => {
    page.draft = text
  }
  const cdp = {
    evaluate: async (expression: string) => {
      reads++
      if (expression === CHATGPT_INSPECT_EXPRESSION) return structuredClone(page)
      if (expression === CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
        return (
          options.imageEvidence ?? {
            url: page.url,
            composer: [],
            users: page.users.map((user) => ({ id: user.id, attachments: [] })),
          }
        )
      if (expression === CHATGPT_ONBOARDING_DISMISS_EXPRESSION) return overlay
      if (expression.includes("max - now")) return selectSteps
      if (expression.includes("return trigger?.getAttribute")) return pickerOpen
      if (expression.includes("Cannot read the visible Chat model row")) pickerOpen = true
      return true
    },
    clickSelector: async (selector: string, beforeDispatch?: () => Promise<void>) => {
      if (covered) throw Error("Control is covered; no click dispatched")
      await beforeDispatch?.()
      clicks.push(selector)
      if (selector === overlay?.selector) overlay = null
    },
    insertText: async (text: string) => {
      inserted.push(text)
      insert(text)
    },
    setInputFiles: async (_selector: string, files: string[]) => {
      uploads.push(files)
      page.attachments = files.map(() => ({ name: "", status: "unknown" as const }))
      if (!options.pendingUpload)
        page.attachments = files.map((file) => ({ name: file.split(/[\\/]/).at(-1)!, status: "ready" as const }))
      else
        setTimeout(() => {
          page.attachments = files.map((file) => ({ name: file.split(/[\\/]/).at(-1)!, status: "ready" as const }))
        }, 20)
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
    pressEscape: async () => {
      pickerOpen = false
    },
    pressArrowRight: async () => {
      rightPresses++
      if (rightPresses === selectSteps) {
        page.model = "GPT-6 Pro"
        page.targetModel = true
      }
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
    inserted,
    uploads,
    cover: () => {
      covered = true
    },
    onInsert: (fn: (text: string) => void) => {
      insert = fn
    },
    reads: () => reads,
    focuses: () => focuses,
    select: (steps: number) => {
      selectSteps = steps
    },
    rightPresses: () => rightPresses,
    pickerOpen: () => pickerOpen,
    overlay: () => {
      overlay = { heading: "Introducing new features", selector: '[data-opencode-gpt-pro-dismiss="true"]' }
    },
    hide: () => {
      hidden = true
    },
    respond: (status: number, path = "/backend-api/f/conversation") =>
      response({ origin: "https://chatgpt.com", path, status }),
  }
}

describe("gpt-pro trusted submission", () => {
  test("a covered send control hands off before recording any send attempt", async () => {
    const f = fixture()
    f.cover()
    let recorded = 0
    await expect(
      f.driver.submit(async () => {
        recorded++
      }),
    ).rejects.toThrow("covered")
    expect(recorded).toBe(0)
    expect(f.clicks).toHaveLength(0)
  })
  test("verifies a long multiline prompt with blank lines, Unicode and LaTeX before sending", async () => {
    const f = fixture()
    f.page.draft = ""
    const prompt =
      "Research Yang\u2013Lee theory.\n\nPlease cover:\n1. " +
      "Non-unitary TQFT. ".repeat(100) +
      "\n2. $F^\\dagger F \\neq 1$\n\nUse references."
    await f.driver.fill(prompt)
    expect(f.inserted).toEqual([prompt])
    expect(f.page.draft).toBe(prompt)
    expect(f.logs.join("\n")).toContain("composer verified")
    expect(f.clicks).toHaveLength(0)
    await f.driver.submit()
    expect(f.clicks).toHaveLength(1)
  })
  test("uploads files once and requires ready card, preview, and remove evidence", async () => {
    const f = fixture()
    await f.driver.uploadAttachments([{ path: "/private/stage/a.md", name: "a.md" }], true)
    expect(f.uploads).toEqual([["/private/stage/a.md"]])
    expect(f.page.attachments).toEqual([{ name: "a.md", status: "ready" }])
    expect(f.logs.join("\n")).toContain("attachments verified ready")
  })
  test("waits through nameless pending cards before reconciling renamed ready cards", async () => {
    const f = fixture({ pendingUpload: true })
    await f.driver.uploadAttachments(
      [{ path: "/private/stage/job-prefix-report.pdf", name: "job-prefix-report.pdf" }],
      true,
    )
    expect(f.uploads).toEqual([["/private/stage/job-prefix-report.pdf"]])
    expect(f.logs.join("\n")).toContain("unknown:unknown")
    expect(f.logs.join("\n")).toContain("job-prefix-report.pdf:ready")
  })
  test("reconciles ready attachments after restart without uploading again", async () => {
    const f = fixture()
    f.page.attachments = [{ name: "a.md", status: "ready" }]
    await f.driver.uploadAttachments([{ path: "/private/stage/a.md", name: "a.md" }], false)
    expect(f.uploads).toHaveLength(0)
    expect(f.logs.join("\n")).toContain("no duplicate upload dispatched")
  })
  test("does not adopt a same-name manual attachment on the initial upload path", async () => {
    const f = fixture()
    f.page.attachments = [{ name: "a.md", status: "ready" }]
    await expect(f.driver.uploadAttachments([{ path: "/private/stage/a.md", name: "a.md" }], true)).rejects.toThrow(
      "predate this consultation",
    )
    expect(f.uploads).toHaveLength(0)
  })
  test("discards image evidence if the page changes between snapshots", async () => {
    const f = fixture({
      imageEvidence: {
        url: `${GPT_PRO_URL}c/other`,
        composer: [{ name: "chart.png", kind: "image", sha256: "a".repeat(64), status: "ready" }],
        users: [],
      },
    })
    await expect(f.driver.page()).rejects.toThrow("page changed during image attachment inspection")
  })
  test("does not reinterpret a PDF preview thumbnail as image attachment evidence", async () => {
    const f = fixture({
      imageEvidence: {
        url: GPT_PRO_URL,
        composer: [{ name: "job-prefix-chart.png", kind: "image", sha256: "b".repeat(64), status: "ready" }],
        users: [],
      },
    })
    f.page.attachments = [
      { name: "job-prefix-report.pdf", status: "ready" },
      { name: "job-prefix-chart.png", status: "unknown" },
    ]
    const page = await f.driver.page()
    expect(page.attachments).toEqual([
      { name: "job-prefix-report.pdf", status: "ready" },
      { name: "job-prefix-chart.png", kind: "image", sha256: "b".repeat(64), status: "ready" },
    ])
  })
  test("refuses partial, stale, or failed attachment state without duplicate upload", async () => {
    const partial = fixture()
    partial.page.attachments = [{ name: "a.md", status: "ready" }]
    await expect(
      partial.driver.uploadAttachments(
        [
          { path: "/private/stage/a.md", name: "a.md" },
          { path: "/private/stage/b.md", name: "b.md" },
        ],
        false,
      ),
    ).rejects.toThrow("partial or ambiguous")
    const stale = fixture()
    stale.page.attachments = [{ name: "other.md", status: "ready" }]
    await expect(stale.driver.uploadAttachments([{ path: "/private/stage/a.md", name: "a.md" }], false)).rejects.toThrow(
      "partial or ambiguous",
    )
    const failed = fixture()
    failed.page.attachments = [{ name: "a.md", status: "failed" }]
    await expect(failed.driver.uploadAttachments([{ path: "/private/stage/a.md", name: "a.md" }], false)).rejects.toThrow(
      "partial or ambiguous",
    )
    expect(partial.uploads).toHaveLength(0)
    expect(stale.uploads).toHaveLength(0)
    expect(failed.uploads).toHaveLength(0)
  })
  test("waits for asynchronous editor reconciliation without typing a second copy", async () => {
    const f = fixture()
    f.page.draft = ""
    f.onInsert((text) => {
      setTimeout(() => {
        f.page.draft = text
      }, 20)
    })
    await f.driver.fill("First\n\nSecond")
    expect(f.inserted).toEqual(["First\n\nSecond"])
    expect(f.logs.join("\n")).toContain("composer mismatch attempt=1")
    expect(f.logs.join("\n")).toContain("composer verified")
    expect(f.clicks).toHaveLength(0)
  })
  test("waits when the composer renders before the model picker", async () => {
    const f = fixture()
    f.page.model = ""
    f.page.targetModel = false
    const waiting = f.driver.ready()
    await new Promise((resolve) => setTimeout(resolve, 20))
    f.page.model = "Pro"
    expect((await waiting).model).toBe("Pro")
    expect(f.logs.join("\n")).toContain("model=pending")
    expect(f.clicks).toHaveLength(0)
  })
  test("dismisses a recognized feature overlay before confirming readiness", async () => {
    const f = fixture()
    f.overlay()
    expect((await f.driver.ready()).composer).toBe(true)
    expect(f.clicks).toEqual(['[data-opencode-gpt-pro-dismiss="true"]'])
    expect(f.logs.join("\n")).toContain("dismissing promotional overlay")
    expect(f.page.draft).toBe("Question")
  })
  test("selects and verifies Pro through the observed Power slider without sending", async () => {
    const f = fixture()
    f.page.model = "High"
    f.page.targetModel = false
    f.select(2)
    expect((await f.driver.verify()).targetModel).toBe(true)
    expect(f.rightPresses()).toBe(2)
    expect(f.pickerOpen()).toBe(false)
    expect(f.clicks).toHaveLength(0)
    expect(f.logs.join("\n")).toContain("selecting Pro power steps=2")
  })
  test("refuses unverified models and closes the picker without filling or sending", async () => {
    const f = fixture()
    f.page.model = "GPT-5.5 Pro"
    f.page.targetModel = false
    await expect(f.driver.verify()).rejects.toThrow("Could not select and verify GPT-6 Pro")
    expect(f.pickerOpen()).toBe(false)
    expect(f.rightPresses()).toBe(0)
    expect(f.clicks).toHaveLength(0)
    expect(f.page.draft).toBe("Question")
  })
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
  test("records the send intent at the trusted-click boundary rather than on entering submit", async () => {
    const f = fixture()
    f.page.sendReady = false
    let recorded = 0
    const sending = f.driver.submit(async () => {
      recorded++
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(recorded).toBe(0)
    f.page.sendReady = true
    await sending
    expect(recorded).toBe(1)
    expect(f.clicks).toHaveLength(1)
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
  test("explicit agent recovery clears a historical rejection without hiding a rendered verification challenge", async () => {
    const f = fixture()
    await f.driver.ready()
    f.respond(403)
    expect((await f.driver.page()).error?.kind).toBe("request")
    f.driver.recover()
    expect((await f.driver.page()).error).toBeUndefined()
    f.page.error = { kind: "verification", message: "Human verification required" }
    f.driver.recover()
    expect((await f.driver.page()).error?.kind).toBe("verification")
  })
  test("a preparation 403 does not override a rendered accepted question that is already generating", async () => {
    const f = fixture()
    await f.driver.ready()
    f.respond(403, "/backend-api/f/conversation/prepare")
    expect((await f.driver.page()).error).toBeUndefined()
    f.page.users = [{ id: "accepted", text: "Question" }]
    f.page.generating = true
    expect((await f.driver.page()).error).toBeUndefined()
    expect(f.logs.join("\n")).toContain("superseded by rendered question/reply")
    f.page.generating = false
    expect((await f.driver.page()).error).toBeUndefined()
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
