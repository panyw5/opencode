import { describe, expect, test } from "bun:test"
import { GptProDriver } from "./gpt-pro-driver"
import { GptProPageError } from "./gpt-pro-page-error"
import { GPT_PRO_PARTITION, GPT_PRO_URL, type GptProPageState } from "@opencode-ai/util/gpt-pro"
import {
  CHATGPT_INSPECT_EXPRESSION,
  CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION,
  CHATGPT_ONBOARDING_DISMISS_EXPRESSION,
  CHATGPT_SEND_TARGET_EXPRESSION,
} from "@opencode-ai/util/chatgpt-page"

function fixture(
  options: {
    imageEvidence?: {
      url: string
      composer: Array<{ name: string; kind: "image"; sha256?: string; status: "ready" | "unknown" }>
      users: Array<{
        id?: string
        attachments: Array<{ name: string; kind: "image"; sha256?: string; status: "ready" | "unknown" }>
      }>
    }
    pendingUpload?: boolean
    inputAvailable?: boolean
    persistentOverlay?: boolean
    focusAccepted?: boolean
    sendUidMatches?: boolean
    afterInspect?: (page: GptProPageState, count: number) => void
  } = {},
) {
  const page: GptProPageState = {
    url: GPT_PRO_URL,
    model: "GPT-6 Pro",
    targetModel: true,
    composer: true,
    draft: "Question",
    generating: false,
    revision: 0,
    users: [],
    attachmentInput: options.inputAvailable ?? true,
    sendReady: true,
    sendControlDiagnostics: { reason: "ok", editorCount: 1, scopedControlCount: 1 },
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
  let inspectCount = 0
  const inserted: string[] = []
  const uploads: string[][] = []
  const resolvedClicks: string[] = []
  let insert = (text: string) => {
    page.draft = text
  }
  const cdp = {
    evaluate: async (expression: string) => {
      reads++
      if (expression === CHATGPT_INSPECT_EXPRESSION) {
        const snapshot = structuredClone(page)
        options.afterInspect?.(page, ++inspectCount)
        return snapshot
      }
      if (expression === CHATGPT_IMAGE_ATTACHMENTS_EXPRESSION)
        return (
          options.imageEvidence ?? {
            url: page.url,
            composer: [],
            users: page.users.map((user) => ({ id: user.id, attachments: [] })),
          }
        )
      if (expression === CHATGPT_ONBOARDING_DISMISS_EXPRESSION) return overlay
      if (expression.includes("document.activeElement===editor")) return options.focusAccepted ?? true
      if (expression.includes("max - now")) return selectSteps
      if (expression.includes("return trigger?.getAttribute")) return pickerOpen
      if (expression.includes("Cannot read the visible Chat model row")) pickerOpen = true
      return true
    },
    clickSelector: async (selector: string, beforeDispatch?: () => Promise<void>) => {
      if (covered) throw Error("Control is covered; no click dispatched")
      await beforeDispatch?.()
      clicks.push(selector)
      if (selector === overlay?.selector && !options.persistentOverlay) overlay = null
    },
    clickResolved: async (expression: string, beforeDispatch?: () => Promise<void>) => {
      if (covered) throw Error("Control is covered; no click dispatched")
      await beforeDispatch?.()
      resolvedClicks.push(expression)
      clicks.push(expression)
    },
    click: async (uid: string, _position?: { x: number; y: number }, beforeDispatch?: () => Promise<void>) => {
      if (covered) throw Error("Control is covered; no click dispatched")
      await beforeDispatch?.()
      clicks.push(`uid:${uid}`)
    },
    matchesResolved: async (_uid: string, _expression: string) => options.sendUidMatches ?? true,
    matches: async () => true,
    matchesText: async () => false,
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
    resolvedClicks,
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
  test("binds hidden pages to distinct WebContents identities on the shared GPT profile", async () => {
    const pages = new Map<string, { pageID: string; partition: string; profileID: string; url: string; epoch: number }>()
    const opened: Array<{ pageID: string; profileID: string; url: string; kind?: string; owner?: unknown }> = []
    const presented: string[] = []
    const browser = {
      getState: () => [...pages.values()],
      openPage: async (
        pageID: string,
        profileID: string,
        url: string,
        metadata: { kind?: string; owner?: unknown },
      ) => {
        opened.push({ pageID, profileID, url, ...metadata })
        const state = { pageID, partition: pageID, profileID, url, epoch: 1 }
        pages.set(pageID, state)
        return state
      },
      cdp: () => ({
        evaluate: async (expression: string) =>
          expression === CHATGPT_INSPECT_EXPRESSION
            ? {
                url: GPT_PRO_URL,
                model: "Website selection",
                targetModel: false,
                composer: true,
                draft: "",
                generating: false,
                revision: 0,
                users: [],
              }
            : { url: GPT_PRO_URL, composer: [], users: [] },
      }),
      present: (pageID: string) => presented.push(pageID),
      has: (pageID: string) => pages.has(pageID),
    }
    const ownerA = { directory: "/repo", sessionID: "ses_a" }
    const ownerB = { directory: "/repo", sessionID: "ses_b" }
    const first = new GptProDriver(browser as never, () => {}, {
      pageID: "gpt-pro-page-one",
      profileID: GPT_PRO_PARTITION,
      owner: ownerA,
    })
    const second = new GptProDriver(browser as never, () => {}, {
      pageID: "gpt-pro-page-two",
      profileID: GPT_PRO_PARTITION,
      owner: ownerB,
    })
    await first.open(GPT_PRO_URL, true)
    await second.open(GPT_PRO_URL, true)
    expect(opened).toEqual([
      { pageID: "gpt-pro-page-one", profileID: GPT_PRO_PARTITION, url: GPT_PRO_URL, kind: "consultation", owner: ownerA },
      { pageID: "gpt-pro-page-two", profileID: GPT_PRO_PARTITION, url: GPT_PRO_URL, kind: "consultation", owner: ownerB },
    ])
    expect(presented).toEqual([])
    expect(await first.page()).toMatchObject({ composer: true, users: [] })
    pages.set("gpt-pro-page-one", { ...pages.get("gpt-pro-page-one")!, epoch: 2 })
    await expect(first.page()).rejects.toThrow("generation changed")
    expect(await second.page()).toMatchObject({ composer: true, users: [] })
  })
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
  test("accepts a ready image preview hash that differs from the verified source hash", async () => {
    const uploadName = "managed-chart-123.png"
    const f = fixture({
      imageEvidence: {
        url: GPT_PRO_URL,
        composer: [{ name: uploadName, kind: "image", sha256: "b".repeat(64), status: "ready" }],
        users: [],
      },
    })
    await f.driver.uploadAttachments(
      [{ path: `/private/stage/${uploadName}`, name: uploadName, mime: "image/png", sha256: "a".repeat(64) }],
      true,
    )
    expect(f.uploads).toEqual([[`/private/stage/${uploadName}`]])
    expect((await f.driver.page()).attachments?.[0]?.sha256).toBe("b".repeat(64))
    expect(f.logs.join("\n")).toContain("attachments verified ready")
  })
  test("does not accept a ready image card without hashed preview evidence", async () => {
    const uploadName = "managed-chart-123.png"
    const f = fixture({
      imageEvidence: {
        url: GPT_PRO_URL,
        composer: [{ name: uploadName, kind: "image", status: "ready" }],
        users: [],
      },
    })
    await expect(
      f.driver.uploadAttachments(
        [{ path: `/private/stage/${uploadName}`, name: uploadName, mime: "image/png", sha256: "a".repeat(64) }],
        true,
      ),
    ).rejects.toThrow("do not match")
    expect(f.uploads).toHaveLength(1)
  })
  test("waits briefly for the active composer input instead of failing on an early mount", async () => {
    const f = fixture({ inputAvailable: false })
    setTimeout(() => {
      f.page.attachmentInput = true
    }, 30)
    await f.driver.uploadAttachments([{ path: "/private/stage/later.txt", name: "later.txt" }], true)
    expect(f.uploads).toEqual([["/private/stage/later.txt"]])
    expect(f.logs.join("\n")).toContain("waiting for active composer file input")
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
  test("fails closed after bounded retries when image evidence stays on another page", async () => {
    const f = fixture({
      imageEvidence: {
        url: `${GPT_PRO_URL}c/other`,
        composer: [{ name: "chart.png", kind: "image", sha256: "a".repeat(64), status: "ready" }],
        users: [],
      },
    })
    await expect(f.driver.page()).rejects.toThrow("snapshot could not be confirmed consistently")
    expect(f.logs.join("\n")).toContain("attempt=3/3")
    expect(f.logs.join("\n")).toContain("no page action may be dispatched")
  })
  test("retries a transient navigation race and returns only a matching snapshot", async () => {
    let changed = false
    const f = fixture({
      afterInspect: (page, count) => {
        if (changed || count !== 1) return
        changed = true
        page.url = `${GPT_PRO_URL}c/current`
        page.users = [{ id: "current-user", text: "Question" }]
      },
    })
    const page = await f.driver.page()
    expect(page.url).toBe(`${GPT_PRO_URL}c/current`)
    expect(page.users).toEqual([{ id: "current-user", text: "Question" }])
    expect(f.logs.join("\n")).toContain("snapshot consistency restored attempt=2/3")
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
    await expect(
      stale.driver.uploadAttachments([{ path: "/private/stage/a.md", name: "a.md" }], false),
    ).rejects.toThrow("partial or ambiguous")
    const failed = fixture()
    failed.page.attachments = [{ name: "a.md", status: "failed" }]
    await expect(
      failed.driver.uploadAttachments([{ path: "/private/stage/a.md", name: "a.md" }], false),
    ).rejects.toThrow("partial or ambiguous")
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
  test("readiness never waits for model recognition when the composer is ready", async () => {
    const f = fixture()
    f.page.model = ""
    f.page.targetModel = false
    expect((await f.driver.ready()).model).toBe("")
    expect(f.logs.join("\n")).toContain("model=pending")
    expect(f.clicks).toHaveLength(0)
  })
  test("dismisses a recognized feature overlay before confirming readiness", async () => {
    const f = fixture()
    f.overlay()
    expect((await f.driver.ready()).composer).toBe(true)
    expect(f.clicks).toEqual(['[data-opencode-gpt-pro-dismiss="true"]'])
    expect(f.logs.join("\n")).toContain("best-effort promo dismissal")
    expect(f.page.draft).toBe("Question")
  })
  test("a promo that cannot be dismissed is not itself a readiness gate", async () => {
    const f = fixture({ persistentOverlay: true })
    f.overlay()
    expect((await f.driver.ready()).composer).toBe(true)
    expect(f.clicks).toHaveLength(3)
    expect(f.logs.join("\n")).toContain("best-effort dismissal")
    expect(f.logs.join("\n")).toContain("focus and send hit tests decide readiness")
  })
  test("observes the current selection without opening menus or adjusting effort", async () => {
    const f = fixture()
    f.page.model = "High"
    f.page.targetModel = false
    f.select(2)
    expect((await f.driver.observeModel()).model).toBe("High")
    expect(f.rightPresses()).toBe(0)
    expect(f.pickerOpen()).toBe(false)
    expect(f.clicks).toHaveLength(0)
    expect(f.logs.join("\n")).toContain("nonblocking=true")
  })
  test("an unrecognized model is informational rather than a preparation gate", async () => {
    const f = fixture()
    f.page.model = "GPT-5.5 Pro"
    f.page.targetModel = false
    expect((await f.driver.observeModel()).model).toBe("GPT-5.5 Pro")
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
  test("distinguishes an unavailable browser view from an unexpected origin", async () => {
    const unavailable = fixture()
    unavailable.hide()
    await expect(unavailable.driver.page()).rejects.toThrow("browser view is unavailable")

    const origin = fixture()
    origin.page.url = "https://example.invalid/"
    await expect(origin.driver.page()).rejects.toThrow("unexpected origin")
    expect(origin.page.url).not.toContain("login")
  })
  test("composer readiness timeout describes loading or interface drift, not authentication", async () => {
    const f = fixture()
    f.page.composer = false
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") queueMicrotask(callback)
      return 0 as never
    }) as typeof setTimeout
    try {
      await expect(f.driver.ready()).rejects.toThrow("No message was sent")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
    expect(f.logs.join("\n")).toContain("composer=false")
  })
  test("does not type when the composer refuses focus", async () => {
    const f = fixture({ focusAccepted: false })
    f.page.draft = ""
    await expect(f.driver.fill("Question")).rejects.toThrow("cannot be focused")
    expect(f.inserted).toHaveLength(0)
    expect(f.clicks).toHaveLength(0)
  })
  test("does not send if text insertion lands outside the inspected composer", async () => {
    const f = fixture()
    f.page.draft = ""
    f.onInsert(() => {
      f.page.draft = "Wrong editor received the input"
    })
    await expect(f.driver.fill("Question").then(() => f.driver.submit())).rejects.toThrow(
      "Chat composer verification failed",
    )
    expect(f.inserted).toEqual(["Question"])
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
    expect(f.clicks[0]).toBe(CHATGPT_SEND_TARGET_EXPRESSION)
    expect(f.resolvedClicks).toEqual([CHATGPT_SEND_TARGET_EXPRESSION])
    expect(f.logs.join("\n")).toContain("one trusted")
  })
  test("treats optional send diagnostics as informational when sendReady is true", async () => {
    const f = fixture()
    f.page.sendControlDiagnostics = undefined
    await f.driver.submit()
    expect(f.clicks).toEqual([CHATGPT_SEND_TARGET_EXPRESSION])
    expect(f.logs.join("\n")).toContain("reason=missing")
  })
  test("recovery UID must match the exact current resolver target", async () => {
    const f = fixture({ sendUidMatches: false })
    let recorded = false
    await expect(
      f.driver.submit(async () => {
        recorded = true
      }, "n99"),
    ).rejects.toThrow("not the exact current send target")
    expect(recorded).toBe(false)
    expect(f.clicks).toHaveLength(0)
    expect(f.resolvedClicks).toHaveLength(0)
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
  test("a visible browser verification prevents submission", async () => {
    const f = fixture()
    f.page.error = { kind: "verification", scope: "page", message: "ChatGPT verification required" }
    await expect(f.driver.submit()).rejects.toBeInstanceOf(GptProPageError)
    expect(f.clicks).toHaveLength(0)
  })
  test("a missing model label cannot block a trusted send", async () => {
    const f = fixture()
    f.page.model = ""
    f.page.targetModel = false
    await f.driver.fill("Exact question")
    await f.driver.uploadAttachments([{ path: "/private/stage/a.md", name: "a.md" }], true)
    await f.driver.submit()
    expect(f.clicks).toHaveLength(1)
    expect(f.logs.join("\n")).toContain("policy=user-selected nonblocking=true")
  })
  test("records backend response diagnostics without creating a sticky page error", async () => {
    const f = fixture()
    await f.driver.ready()
    f.respond(403, "/backend-api/unrelated")
    expect((await f.driver.page()).error).toBeUndefined()
    f.respond(403)
    expect((await f.driver.page()).error).toBeUndefined()
    expect((await f.driver.ready()).composer).toBe(true)
    expect(f.logs.join("\n")).toContain("no headers or body recorded")
    expect(f.logs.join("\n")).toContain("webpage state remains authoritative")
  })
  test("a backend 403 does not block draft fill, attachment upload, or rendered answer tracking", async () => {
    const f = fixture()
    await f.driver.ready()
    f.respond(403, "/backend-api/f/conversation/prepare")
    f.page.draft = ""
    await f.driver.fill("Question after a preparation 403")
    await f.driver.uploadAttachments([{ path: "/private/stage/evidence.md", name: "evidence.md" }], true)
    f.page.users = [{ id: "accepted-user", text: "Question after a preparation 403" }]
    f.page.answer = {
      id: "answer-1",
      userID: "accepted-user",
      text: "Visible answer",
      html: "<p>Visible answer</p>",
      complete: true,
      truncated: false,
    }
    expect((await f.driver.page()).answer?.text).toBe("Visible answer")
    expect((await f.driver.page()).error).toBeUndefined()
    expect(f.uploads).toHaveLength(1)
    expect(f.inserted).toEqual(["Question after a preparation 403"])
  })
  test("passes turn-scoped request diagnostics to the controller instead of blocking another turn", async () => {
    const f = fixture()
    f.page.error = { kind: "request", scope: "turn", userID: "previous-user", message: "Previous turn failed" }
    f.page.draft = ""
    expect((await f.driver.ready()).composer).toBe(true)
    await f.driver.fill("Current consultation question")
    await f.driver.uploadAttachments([{ path: "/private/stage/current.md", name: "current.md" }], true)
    await f.driver.submit()
    expect(f.clicks).toHaveLength(1)
    expect(f.logs.join("\n")).toContain("passing request diagnostic scope=turn")
  })
  test("passes page-scoped request diagnostics to the owner but blocks global verification", async () => {
    const request = fixture()
    request.page.error = { kind: "request", scope: "page", message: "Page-level request failure" }
    expect((await request.driver.ready()).composer).toBe(true)
    expect(request.clicks).toHaveLength(0)
    expect(request.logs.join("\n")).toContain("passing request diagnostic scope=page")

    const verification = fixture()
    verification.page.error = { kind: "verification", scope: "turn", userID: "old", message: "Verify browser" }
    await expect(verification.driver.submit()).rejects.toBeInstanceOf(GptProPageError)
    expect(verification.clicks).toHaveLength(0)
  })
  test("a visible verification error still blocks send after a diagnostic 403", async () => {
    const verification = fixture()
    await verification.driver.ready()
    verification.respond(403, "/backend-api/f/conversation/prepare")
    verification.page.error = { kind: "verification", message: "Human verification required" }
    await expect(verification.driver.submit()).rejects.toBeInstanceOf(GptProPageError)
    expect(verification.clicks).toHaveLength(0)
  })
  test("recovery never hides a rendered verification challenge", async () => {
    const f = fixture()
    f.page.error = { kind: "verification", message: "Human verification required" }
    f.driver.recover()
    expect((await f.driver.page()).error?.kind).toBe("verification")
  })
  test("a preparation 403 has no effect on rendered accepted user and generation state", async () => {
    const f = fixture()
    await f.driver.ready()
    f.respond(403, "/backend-api/f/conversation/prepare")
    expect((await f.driver.page()).error).toBeUndefined()
    f.page.users = [{ id: "accepted", text: "Question" }]
    f.page.generating = true
    expect((await f.driver.page()).error).toBeUndefined()
    expect((await f.driver.page()).users[0]?.id).toBe("accepted")
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
