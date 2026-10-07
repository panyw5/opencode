import { describe, expect, test } from "bun:test"
import { GptProController, type GptProDriverAPI } from "./gpt-pro-controller"
import { GPT_PRO_URL, type GptProConfig, type GptProJob, type GptProPageState } from "@opencode-ai/util/gpt-pro"
import { GptProPageError } from "./gpt-pro-page-error"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Expected consultation state was not reached")
    await new Promise((r) => setTimeout(r, 1))
  }
}
function fixture(
  options: {
    enabled?: boolean
    open?: () => Promise<void>
    verify?: () => Promise<GptProPageState>
    loaded?: GptProJob[]
    stop?: () => Promise<void>
    stagingRoot?: string
    initialPage?: GptProPageState
    upload?: (
      files: Array<{ path: string; name: string; mime?: string; sha256?: string }>,
      mayDispatch: boolean,
      shouldContinue: (() => Promise<boolean>) | undefined,
      setAttachments: (attachments: NonNullable<GptProPageState["attachments"]>) => void,
    ) => Promise<void>
    sentAttachments?: string[]
    sentAttachmentStatus?: "ready" | "unknown"
    submitGate?: () => Promise<void>
  } = {},
) {
  let config: GptProConfig = { enabled: options.enabled ?? true, timeoutMinutes: 30 }
  let saved: GptProJob[] = options.loaded ?? []
  let submits = 0,
    stops = 0,
    fills = 0
  const page: GptProPageState = {
    url: GPT_PRO_URL,
    model: "GPT-6 Pro",
    targetModel: true,
    composer: true,
    draft: "",
    attachmentInput: true,
    generating: false,
    revision: 0,
    users: [],
  }
  if (options.initialPage) Object.assign(page, structuredClone(options.initialPage))
  const driver: GptProDriverAPI = {
    open: async (url = GPT_PRO_URL, fresh) => {
      await options.open?.()
      page.url = url
      if (fresh) {
        page.users = []
        page.answer = undefined
        page.draft = ""
      }
    },
    ready: async () => structuredClone(page),
    page: async () => structuredClone(page),
    verify: options.verify ?? (async () => structuredClone(page)),
    fill: async (prompt) => {
      fills++
      page.draft = prompt
    },
    submit: async (beforeDispatch) => {
      await options.submitGate?.()
      await beforeDispatch?.()
      submits++
      const attachments = options.sentAttachments ?? (page.attachments ?? []).map(({ name }) => name)
      page.users.push({
        id: `user-${submits}`,
        text: page.draft,
        attachments: attachments.map((name) => {
          const composer = page.attachments?.find((attachment) => attachment.name === name)
          return {
            name,
            ...(composer?.kind ? { kind: composer.kind } : {}),
            ...(options.sentAttachmentStatus === "unknown" ? {} : composer?.sha256 ? { sha256: composer.sha256 } : {}),
            status: options.sentAttachmentStatus ?? "ready",
          }
        }),
      })
      page.draft = ""
      page.attachments = []
      page.generating = true
      page.url = `${GPT_PRO_URL}c/test`
      page.answer = undefined
    },
    stop: async () => {
      stops++
      await options.stop?.()
      page.generating = false
    },
    element: async (uid) => ({ composer: uid === "composer", send: uid === "send", retry: uid === "retry" }),
    ...(options.upload
      ? {
          uploadAttachments: (files: Array<{ path: string; name: string }>, mayDispatch: boolean, shouldContinue?: () => Promise<boolean>) =>
            options.upload!(files, mayDispatch, shouldContinue, (attachments) => {
              page.attachments = attachments
            }),
        }
      : {}),
  }
  const logs: string[] = []
  const controller = new GptProController(
    driver,
    {
      load: () => saved,
      save: (jobs) => {
        saved = structuredClone(jobs)
      },
      config: () => config,
      setConfig: (next) => {
        config = next
      },
      stagingRoot: options.stagingRoot ? () => options.stagingRoot! : undefined,
    },
    (line) => logs.push(line),
    1,
    5,
  )
  const finish = (text = "Answer") => {
    const user = page.users.at(-1)!
    page.generating = false
    page.answer = {
      id: `answer-${submits}`,
      userID: user.id,
      text,
      html: `<p>${text}</p>`,
      complete: true,
      truncated: false,
    }
  }
  return { controller, page, finish, logs, counts: () => ({ submits, stops, fills }), saved: () => saved }
}

describe("gpt-pro consultation control", () => {
  test("explicit resume recovers a submitted turn's URL and ID without resending", async () => {
    const job: GptProJob = {
      id: "gpt_receipt",
      owner: "/repo\nses_parent",
      requestID: "receipt",
      phase: "paused",
      prompt: "Long question\n\nSecond paragraph",
      url: GPT_PRO_URL,
      createdAt: 1,
      updatedAt: 1,
      submitted: true,
      model: "GPT-6 Pro",
      userCount: 0,
      revision: 0,
      background: true,
    }
    const f = fixture({ loaded: [job] })
    try {
      f.page.url = GPT_PRO_URL + "c/original"
      f.page.users = [{ id: "original-user", text: job.prompt }]
      f.finish("Full advisor answer")
      await f.controller.command({ action: "resume", id: job.id }, job.owner)
      await until(() => f.controller.list()[0].phase === "completed")
      const result = await f.controller.command({ action: "read", id: job.id }, job.owner)
      expect(result.url).toBe(GPT_PRO_URL + "c/original")
      expect(result.userID).toBe("original-user")
      expect(result.text).toBe("Full advisor answer")
      expect(f.counts()).toEqual({ submits: 0, stops: 0, fills: 0 })
      expect(f.logs.join("\n")).toContain("no question resent")
      expect(f.controller.notifications("/repo").some((e) => e.kind === "completed")).toBe(true)
    } finally {
      f.controller.dispose()
    }
  })
  test("resume never acknowledges a different question as the submitted turn", async () => {
    const job: GptProJob = {
      id: "gpt_receipt",
      owner: "/repo\nses_parent",
      requestID: "receipt",
      phase: "paused",
      prompt: "Original question",
      url: GPT_PRO_URL,
      createdAt: 1,
      updatedAt: 1,
      submitted: true,
      model: "GPT-6 Pro",
      userCount: 0,
      revision: 0,
    }
    const f = fixture({ loaded: [job] })
    try {
      f.page.url = GPT_PRO_URL + "c/unrelated"
      f.page.users = [{ id: "unrelated-user", text: "Different question" }]
      await f.controller.command({ action: "resume", id: job.id }, job.owner)
      await until(() => f.controller.list()[0].phase === "paused")
      const result = await f.controller.command({ action: "read", id: job.id }, job.owner)
      expect(result.userID).toBeUndefined()
      expect(result.url).toBe(GPT_PRO_URL)
      expect(f.counts()).toEqual({ submits: 0, stops: 0, fills: 0 })
    } finally {
      f.controller.dispose()
    }
  })
  test("promotion retains the original question and completion outbox survives until acknowledged", async () => {
    const f = fixture()
    try {
      const owner = "/repo\nses_parent"
      const j = await f.controller.command({ prompt: "Question" }, owner)
      await until(() => f.page.generating)
      await f.controller.command({ action: "background", id: j.id }, owner)
      expect(f.counts().submits).toBe(1)
      f.finish()
      await until(() => f.controller.list()[0]?.phase === "completed")
      const events = f.controller.notifications("/repo")
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ owner, kind: "completed", text: "Answer" })
      f.controller.acknowledge(
        "/wrong",
        events.map((e) => e.id),
      )
      expect(f.controller.notifications("/repo")).toHaveLength(1)
      f.controller.acknowledge(
        "/repo",
        events.map((e) => e.id),
      )
      expect(f.controller.notifications("/repo")).toHaveLength(0)
      expect(f.saved()[0].notificationSequence).toBe(1)
    } finally {
      f.controller.dispose()
    }
  })
  test("background requires an OpenCode parent rather than an unbound human owner", async () => {
    const f = fixture()
    try {
      await expect(f.controller.command({ prompt: "Question", background: true })).rejects.toThrow(
        "parent OpenCode session",
      )
      expect(f.counts().submits).toBe(0)
    } finally {
      f.controller.dispose()
    }
  })
  test("retains the verified submitted model when the next composer remounts", async () => {
    let verifies = 0
    const f = fixture({
      verify: async () => {
        if (++verifies > 1) throw Error("The next composer has no model evidence yet")
        return structuredClone(f.page)
      },
    })
    try {
      await f.controller.command({ prompt: "Question" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      f.page.model = ""
      f.page.targetModel = false
      f.finish()
      await until(() => f.controller.list()[0].phase === "completed")
      expect(verifies).toBe(1)
      expect(f.controller.list()[0].model).toBe("GPT-6 Pro")
      expect(f.counts().submits).toBe(1)
    } finally {
      f.controller.dispose()
    }
  })
  test("a website rejection hands off once and reserves the original browser without resending", async () => {
    const f = fixture()
    try {
      const job = await f.controller.command({ prompt: "Question", requestID: "rejected" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      f.page.error = { kind: "request", message: "ChatGPT rejected request (HTTP 403)" }
      await until(() => !!f.controller.list()[0].recovery)
      expect(f.controller.busy()).toBe(true)
      expect(f.controller.list()[0].recovery?.stage).toBe("track")
      expect(f.counts().submits).toBe(1)
      expect((await f.controller.command({ prompt: "Question", requestID: "rejected" }, "main")).id).toBe(job.id)
      expect(f.counts().submits).toBe(1)
      expect((await f.controller.command({ action: "read", id: job.id }, "main")).error).toContain("403")
    } finally {
      f.controller.dispose()
    }
  })
  test("verification failures do not fill or send a question", async () => {
    const f = fixture({
      verify: async () => {
        throw new GptProPageError("Browser verification required", "verification")
      },
    })
    try {
      await f.controller.command({ prompt: "Question" }, "main")
      await until(() => !!f.controller.list()[0].recovery)
      expect(f.controller.list()[0].recovery?.needsHuman).toBe(true)
      expect(f.counts().fills).toBe(0)
      expect(f.counts().submits).toBe(0)
    } finally {
      f.controller.dispose()
    }
  })
  test("requires explicit enablement before sending", async () => {
    const f = fixture({ enabled: false })
    await expect(f.controller.command({ prompt: "Question" }, "owner")).rejects.toThrow("Enable")
    expect(f.counts().submits).toBe(0)
    f.controller.dispose()
  })
  test("stages validated attachment bytes under an owned path preserving the basename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-stage-"))
    try {
      const original = path.join(root, "source.md")
      const bytes = Buffer.from("# attachment\n")
      await writeFile(original, bytes)
      const original2 = path.join(root, "other", "source.md")
      const bytes2 = Buffer.from("# second attachment\n")
      await mkdir(path.dirname(original2), { recursive: true })
      await writeFile(original2, bytes2)
      const original3 = path.join(root, "long-source.md")
      const bytes3 = Buffer.from("# long name attachment\n")
      const longName = `${"数据".repeat(150)}.md`
      await writeFile(original3, bytes3)
      const f = fixture({ stagingRoot: path.join(root, "owned") })
      const job = await f.controller.command({
        action: "consult",
        requestID: "stage-test",
        prompt: "Review the attached document",
        attachments: [
          {
            id: "file_1",
            name: "source.md",
            path: original,
            mime: "text/markdown",
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          {
            id: "file_2",
            name: "source.md",
            path: original2,
            mime: "text/markdown",
            size: bytes2.byteLength,
            sha256: createHash("sha256").update(bytes2).digest("hex"),
          },
          {
            id: "file_3",
            name: longName,
            path: original3,
            mime: "text/markdown",
            size: bytes3.byteLength,
            sha256: createHash("sha256").update(bytes3).digest("hex"),
          },
        ],
      })
      expect(job.attachments?.[0].status).toBe("pending")
      expect(job.attachments?.[0].path).toBeUndefined()
      expect(job.stagedAttachments).toBeUndefined()
      const stagedPath = f.saved()[0].stagedAttachments![0].path
      const stagedPath2 = f.saved()[0].stagedAttachments![1].path
      const stagedPath3 = f.saved()[0].stagedAttachments![2].path
      const uploadName = f.saved()[0].attachments![0].uploadName
      const uploadName2 = f.saved()[0].attachments![1].uploadName
      const uploadName3 = f.saved()[0].attachments![2].uploadName
      expect(uploadName).not.toBe("source.md")
      expect(uploadName).not.toBe(uploadName2)
      expect(Buffer.byteLength(uploadName, "utf8")).toBeLessThanOrEqual(255)
      expect(Buffer.byteLength(uploadName3, "utf8")).toBeLessThanOrEqual(255)
      expect(uploadName3.endsWith(".md")).toBe(true)
      expect(stagedPath.endsWith(path.join("file_1", uploadName))).toBe(true)
      expect(stagedPath2.endsWith(path.join("file_2", uploadName2))).toBe(true)
      expect(stagedPath3.endsWith(path.join("file_3", uploadName3))).toBe(true)
      expect(stagedPath).not.toBe(stagedPath2)
      expect(await readFile(stagedPath)).toEqual(bytes)
      expect(await readFile(stagedPath2)).toEqual(bytes2)
      expect(await readFile(stagedPath3)).toEqual(bytes3)
      await writeFile(original, "changed")
      await writeFile(original2, "changed too")
      await writeFile(original3, "changed long name too")
      expect(await readFile(stagedPath)).toEqual(bytes)
      expect(await readFile(stagedPath2)).toEqual(bytes2)
      expect(await readFile(stagedPath3)).toEqual(bytes3)
      expect(f.saved()[0].stagedAttachments?.[1].sha256).toBe(createHash("sha256").update(bytes2).digest("hex"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("rejects changed attachment bytes before creating a consultation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-stage-"))
    try {
      const original = path.join(root, "source.txt")
      await writeFile(original, "not the authorized bytes")
      const f = fixture({ stagingRoot: path.join(root, "owned") })
      await expect(
        f.controller.command({
          action: "consult",
          requestID: "changed-source",
          prompt: "Review this",
          attachments: [
            {
              id: "file_1",
              name: "source.txt",
              path: original,
              mime: "text/plain",
              size: 6,
              sha256: createHash("sha256").update("before").digest("hex"),
            },
          ],
        }),
      ).rejects.toThrow("source changed")
      expect(f.controller.list()).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("validates media signatures and deduplicates concurrent attachment requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-stage-"))
    try {
      const invalidPdf = path.join(root, "invalid.pdf")
      const bytes = Buffer.from("not a PDF")
      await writeFile(invalidPdf, bytes)
      const f = fixture({ stagingRoot: path.join(root, "owned") })
      await expect(
        f.controller.command({
          requestID: "invalid-pdf",
          prompt: "Review this",
          attachments: [{
            id: "pdf1",
            name: "invalid.pdf",
            path: invalidPdf,
            mime: "application/pdf",
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }],
        }),
      ).rejects.toThrow("does not match PDF")
      expect(f.controller.list()).toHaveLength(0)

      const original = path.join(root, "source.txt")
      const text = Buffer.from("safe text")
      await writeFile(original, text)
      const descriptor = {
        id: "text1",
        name: "source.txt",
        path: original,
        mime: "text/plain",
        size: text.byteLength,
        sha256: createHash("sha256").update(text).digest("hex"),
      }
      const [first, second] = await Promise.all([
        f.controller.command({ requestID: "same-request", prompt: "Review this", attachments: [descriptor] }),
        f.controller.command({ requestID: "same-request", prompt: "Review this", attachments: [descriptor] }),
      ])
      expect(first.id).toBe(second.id)
      expect(f.saved().filter((job) => job.requestID === "same-request")).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("uploads and verifies attachments before filling and submitting the exact prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-stage-"))
    try {
      const original = path.join(root, "review.md")
      const bytes = Buffer.from("# review\n")
      await writeFile(original, bytes)
      const f = fixture({
        stagingRoot: path.join(root, "owned"),
        upload: async (files, mayDispatch, shouldContinue, setAttachments) => {
          expect(mayDispatch).toBe(true)
          expect(await shouldContinue?.()).toBe(true)
          setAttachments(files.map(({ name }) => ({ name, status: "ready" })))
        },
      })
      const job = await f.controller.command({
        requestID: "upload-ready",
        prompt: "Review the attachment",
        attachments: [{
          id: "review-file",
          name: "review.md",
          path: original,
          mime: "text/markdown",
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }],
      })
      await until(() => f.counts().submits === 1)
      expect(f.counts().fills).toBe(1)
      expect(f.page.users[0].attachments).toEqual([{
        name: job.attachments?.[0].uploadName,
        status: "ready",
      }])
      expect(f.saved()[0].attachments?.[0].status).toBe("ready")
      expect(job.stagedAttachments).toBeUndefined()
      f.finish("Read the exact file")
      await until(() => f.saved()[0].phase === "completed")
      expect(f.saved()[0].text).toBe("Read the exact file")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("partial upload evidence prevents prompt fill and submit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-stage-"))
    try {
      const original = path.join(root, "partial.md")
      const bytes = Buffer.from("# partial\n")
      await writeFile(original, bytes)
      const f = fixture({
        stagingRoot: path.join(root, "owned"),
        upload: async (files, _mayDispatch, _shouldContinue, setAttachments) => {
          setAttachments(files.map(({ name }) => ({ name, status: "uploading" })))
        },
      })
      const job = await f.controller.command({
        requestID: "upload-partial",
        prompt: "Review the attachment",
        attachments: [{
          id: "partial-file",
          name: "partial.md",
          path: original,
          mime: "text/markdown",
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }],
      })
      await until(() => f.saved()[0]?.phase === "paused")
      expect(f.counts().fills).toBe(0)
      expect(f.counts().submits).toBe(0)
      expect(f.saved()[0].attachments?.[0].status).toBe("unknown")
      expect(job.id).toBe(f.saved()[0].id)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("cancellation during upload prevents subsequent typing and submission", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-stage-"))
    let started!: () => void
    const uploadStarted = new Promise<void>((resolve) => (started = resolve))
    let release!: () => void
    const pendingUpload = new Promise<void>((resolve) => (release = resolve))
    try {
      const original = path.join(root, "cancel.md")
      const bytes = Buffer.from("# cancel\n")
      await writeFile(original, bytes)
      const f = fixture({
        stagingRoot: path.join(root, "owned"),
        upload: async (_files, _mayDispatch, shouldContinue) => {
          started()
          await pendingUpload
          if (!(await shouldContinue?.())) throw new Error("Attachment workflow was cancelled")
        },
      })
      const job = await f.controller.command({
        requestID: "upload-cancel",
        prompt: "Review the attachment",
        attachments: [{
          id: "cancel-file",
          name: "cancel.md",
          path: original,
          mime: "text/markdown",
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }],
      })
      await uploadStarted
      await f.controller.command({ action: "stop", id: job.id })
      release()
      await until(() => f.saved()[0]?.phase === "cancelled")
      expect(f.counts().fills).toBe(0)
      expect(f.counts().submits).toBe(0)
    } finally {
      release?.()
      await rm(root, { recursive: true, force: true })
    }
  })
  test("cancellation while the send control is waiting blocks the trusted click", async () => {
    let started!: () => void
    const submitStarted = new Promise<void>((resolve) => (started = resolve))
    let release!: () => void
    const submitGate = new Promise<void>((resolve) => (release = resolve))
    const f = fixture({
      submitGate: async () => {
        started()
        await submitGate
      },
    })
    try {
      const job = await f.controller.command({ prompt: "Boundary cancellation" })
      await submitStarted
      await f.controller.command({ action: "stop", id: job.id })
      release()
      await until(() => f.saved()[0]?.phase === "cancelled")
      expect(f.counts().submits).toBe(0)
      expect(f.saved()[0].sendAttempted).toBeUndefined()
    } finally {
      release?.()
      f.controller.dispose()
    }
  })
  test("tracking rejects a reply when the sent user turn has a different attachment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-stage-"))
    try {
      const original = path.join(root, "expected.md")
      const bytes = Buffer.from("# expected\n")
      await writeFile(original, bytes)
      const f = fixture({
        stagingRoot: path.join(root, "owned"),
        sentAttachments: ["unexpected.md"],
        upload: async (files, _mayDispatch, _shouldContinue, setAttachments) => {
          setAttachments(files.map(({ name }) => ({ name, status: "ready" })))
        },
      })
      const job = await f.controller.command({
        requestID: "upload-turn-mismatch",
        prompt: "Review the attachment",
        attachments: [{
          id: "expected-file",
          name: "expected.md",
          path: original,
          mime: "text/markdown",
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }],
      })
      await until(() => f.saved()[0]?.phase === "paused")
      expect(f.counts().submits).toBe(1)
      expect(f.saved()[0].userID).toBeUndefined()
      expect(f.saved()[0].phase).not.toBe("completed")
      expect(f.saved()[0].error).toContain("changed manually")
      await f.controller.command({ action: "stop", id: job.id })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("waits for an image digest instead of misclassifying a pending thumbnail as a manual change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-image-"))
    try {
      const original = path.join(root, "chart.png")
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      await writeFile(original, bytes)
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const f = fixture({
        stagingRoot: path.join(root, "owned"),
        sentAttachmentStatus: "unknown",
        upload: async (files, _mayDispatch, _shouldContinue, setAttachments) => {
          setAttachments(files.map(({ name, mime, sha256 }) => ({
            name,
            kind: mime?.startsWith("image/") ? "image" : "document",
            sha256,
            status: "ready",
          })))
        },
      })
      const job = await f.controller.command({
        requestID: "image-digest-waits",
        prompt: "Review this chart",
        attachments: [{
          id: "chart-image",
          name: "chart.png",
          path: original,
          mime: "image/png",
          size: bytes.byteLength,
          sha256,
        }],
      })
      await until(() => f.page.generating)
      expect(["sending", "generating"]).toContain(f.controller.list()[0].phase)
      expect(f.page.users[0].attachments?.[0].sha256).toBeUndefined()
      f.finish("Chart received")
      f.page.users[0].attachments = [{ name: "", kind: "image", sha256, status: "ready" }]
      await until(() => f.saved()[0].phase === "completed")
      expect(f.saved()[0].userID).toBe("user-1")
      expect(f.counts().submits).toBe(1)
      expect(job.id).toBe(f.saved()[0].id)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("deduplicates a request and scopes reads to the owning session", async () => {
    const f = fixture()
    try {
      const first = await f.controller.command({ prompt: "Question", requestID: "request" }, "owner")
      const duplicate = await f.controller.command({ prompt: "Question", requestID: "request" }, "owner")
      expect(duplicate.id).toBe(first.id)
      await until(() => f.counts().submits === 1)
      await expect(f.controller.command({ action: "read", id: first.id }, "other")).rejects.toThrow("not found")
      expect(f.logs.join("\n")).not.toContain("Question")
    } finally {
      f.controller.dispose()
    }
  })
  test("stop during preparation never dispatches a later submit", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = fixture({ open: () => blocked })
    const job = await f.controller.command({ prompt: "Question" }, "owner")
    await f.controller.command({ action: "stop", id: job.id }, "owner")
    release()
    await until(() => f.controller.list()[0].phase === "cancelled")
    expect(f.counts().submits).toBe(0)
    f.controller.dispose()
  })
  test("pause and resume track the same question without resending", async () => {
    const f = fixture()
    try {
      const job = await f.controller.command({ prompt: "Question" }, "owner")
      await until(() => f.controller.list()[0].phase === "generating")
      expect((await f.controller.command({ action: "pause", id: job.id }, "owner")).phase).toBe("paused")
      await f.controller.command({ action: "resume", id: job.id }, "owner")
      f.finish()
      await until(() => f.controller.list()[0].phase === "completed")
      expect(f.counts().submits).toBe(1)
      expect((await f.controller.command({ action: "read", id: job.id }, "owner")).html).toBe("<p>Answer</p>")
    } finally {
      f.controller.dispose()
    }
  })
  test("human intervention retains the main-agent owner and redirects its pending result", async () => {
    const f = fixture()
    try {
      const first = await f.controller.command({ prompt: "Original" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      const next = await f.controller.command({
        action: "intervene",
        id: first.id,
        prompt: "Correction",
        requestID: "intervention",
      })
      expect(next.owner).toBe("main")
      expect(next.parentID).toBe(first.id)
      expect((await f.controller.command({ action: "status", id: first.id }, "main")).id).toBe(next.id)
      await until(() => f.counts().submits === 2)
      f.finish("Corrected answer")
      await until(() => f.controller.list().find((j) => j.id === next.id)?.phase === "completed")
      expect((await f.controller.command({ action: "read", id: first.id }, "main")).text).toBe("Corrected answer")
      expect(f.counts().stops).toBe(1)
    } finally {
      f.controller.dispose()
    }
  })
  test("a manual follow-up pauses rather than returning an unrelated answer", async () => {
    const f = fixture()
    try {
      await f.controller.command({ prompt: "Original" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      f.page.users.push({ id: "manual", text: "Another question" })
      f.finish("Unrelated")
      await until(() => f.controller.list()[0].phase === "paused")
      expect(f.controller.list()[0].text).toBeUndefined()
    } finally {
      f.controller.dispose()
    }
  })
  test("a wrong model hands off without dispatching a prompt", async () => {
    const f = fixture({
      verify: async () => {
        throw new Error("Wrong model")
      },
    })
    try {
      await f.controller.command({ prompt: "Original" }, "main")
      await until(() => !!f.controller.list()[0].recovery)
      expect(f.counts().submits).toBe(0)
    } finally {
      f.controller.dispose()
    }
  })
  test("an agent repairs a fixed-flow failure with the same browser lease and resumes one submission", async () => {
    let repaired = false
    const f = fixture({
      verify: async () => {
        if (!repaired) throw Error("Unknown model overlay")
        return structuredClone(f.page)
      },
    })
    try {
      const owner = "/repo\nses_parent"
      const job = await f.controller.command({ prompt: "Question", background: true }, owner)
      await until(() => !!f.controller.list()[0].recovery)
      expect(f.controller.notifications("/repo")[0].recovery?.stage).toBe("model")
      const calls: string[] = []
      const execute = async (partition: string) => {
        calls.push(partition)
        repaired = true
        return { state: { url: f.page.url } }
      }
      await expect(
        f.controller.browserCommand("/other\nses_parent", job.id, "click", { uid: "dismiss" }, execute),
      ).rejects.toThrow("not found")
      await expect(f.controller.browserCommand("/repo\nses_other", job.id, "snapshot", {}, execute)).rejects.toThrow(
        "not found",
      )
      expect(calls).toHaveLength(0)
      await f.controller.browserCommand(owner, job.id, "click", { uid: "dismiss" }, execute)
      expect(calls).toEqual(["persist:consult-gpt-pro"])
      await f.controller.command({ action: "resume", id: job.id }, owner)
      await until(() => f.page.generating)
      f.finish("Recovered answer")
      await until(() => f.controller.list()[0].phase === "completed")
      expect(f.counts().submits).toBe(1)
      expect(
        f.controller.notifications("/repo").some((e) => e.kind === "completed" && e.text === "Recovered answer"),
      ).toBe(true)
      await expect(f.controller.browserCommand(owner, job.id, "click", { uid: "dismiss" }, execute)).rejects.toThrow(
        "only for the active",
      )
    } finally {
      f.controller.dispose()
    }
  })
  test("read-only inspection remains available after recovery is resumed while mutations stay gated", async () => {
    let repaired = false
    const f = fixture({
      verify: async () => {
        if (!repaired) throw Error("Temporary error")
        return structuredClone(f.page)
      },
    })
    try {
      const owner = "/repo\nses_reader"
      const job = await f.controller.command({ prompt: "Question", background: false }, owner)
      await until(() => !!f.controller.list()[0].recovery)
      expect(f.controller.list()[0].background).toBe(true)
      repaired = true
      await f.controller.command({ action: "resume", id: job.id }, owner)
      await until(() => f.page.generating)
      const read = async () => ({ snapshot: { title: "Chat" } })
      expect(await f.controller.browserCommand(owner, job.id, "snapshot", {}, read)).toEqual({
        snapshot: { title: "Chat" },
      })
      await expect(f.controller.browserCommand(owner, job.id, "click", { uid: "dismiss" }, read)).rejects.toThrow(
        "only for the active",
      )
      f.finish("Recovered foreground answer")
      await until(() => f.controller.list()[0].phase === "completed")
      expect(await f.controller.browserCommand(owner, job.id, "snapshot", {}, read)).toEqual({
        snapshot: { title: "Chat" },
      })
      expect(
        f.controller
          .notifications("/repo")
          .some((e) => e.kind === "completed" && e.text === "Recovered foreground answer"),
      ).toBe(true)
      const other = await f.controller.command({ prompt: "Other" }, "/other\nses_other")
      await until(() => f.controller.list().find((j) => j.id === other.id)?.phase === "generating")
      await expect(f.controller.browserCommand(owner, job.id, "snapshot", {}, read)).rejects.toThrow("does not own")
    } finally {
      f.controller.dispose()
    }
  })
  test("managed recovery send accepts an existing exact draft, tracks it, and rejects a second send", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-stage-"))
    const original = path.join(root, "managed.md")
    const bytes = Buffer.from("# managed\n")
    await writeFile(original, bytes)
    const f = fixture({
      stagingRoot: path.join(root, "owned"),
      verify: async () => {
        throw Error("Model picker overlay")
      },
      upload: async (files, _mayDispatch, _shouldContinue, setAttachments) => {
        setAttachments(files.map(({ name }) => ({ name, status: "ready" })))
      },
    })
    try {
      const owner = "/repo\nses_parent"
      const job = await f.controller.command({
        prompt: "Original prompt",
        attachments: [{
          id: "managed-file",
          name: "managed.md",
          path: original,
          mime: "text/markdown",
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }],
      }, owner)
      await until(() => !!f.controller.list()[0].recovery)
      f.page.draft = "Original prompt"
      await expect(f.controller.command({ action: "send", id: job.id, uid: "dismiss" }, owner)).rejects.toThrow(
        "not a send control",
      )
      await f.controller.command({ action: "send", id: job.id, uid: "send" }, owner)
      await expect(f.controller.command({ action: "send", id: job.id, uid: "send" }, owner)).rejects.toThrow(
        "already attempted",
      )
      let retryDispatched = false
      await expect(
        f.controller.browserCommand(owner, job.id, "click", { uid: "retry" }, async () => {
          retryDispatched = true
          return {}
        }),
      ).rejects.toThrow("Retry/regenerate controls are blocked")
      expect(retryDispatched).toBe(false)
      await expect(
        f.controller.browserCommand(owner, job.id, "type", { uid: "composer", text: "Replacement" }, async () => ({})),
      ).rejects.toThrow("only the original")
      await f.controller.command({ action: "resume", id: job.id }, owner)
      f.finish("Original reply")
      await until(() => f.controller.list()[0].phase === "completed")
      expect(f.counts().submits).toBe(1)
      expect(f.counts().fills).toBe(0)
      expect(f.saved()[0].attachments?.[0].status).toBe("ready")
    } finally {
      f.controller.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  test("recovery blocks Enter submission, human-verification clicks and unrelated drafts", async () => {
    const f = fixture({
      verify: async () => {
        throw Error("Overlay")
      },
    })
    try {
      const owner = "/repo\nses_parent"
      const job = await f.controller.command({ prompt: "Original prompt" }, owner)
      await until(() => !!f.controller.list()[0].recovery)
      let dispatched = 0
      const execute = async () => {
        dispatched++
        return {}
      }
      await expect(
        f.controller.browserCommand(
          owner,
          job.id,
          "type",
          { uid: "composer", text: job.prompt, submit: true },
          execute,
        ),
      ).rejects.toThrow("not Enter")
      f.page.draft = "Manual draft"
      await expect(
        f.controller.browserCommand(owner, job.id, "type", { uid: "composer", text: job.prompt }, execute),
      ).rejects.toThrow("unrelated drafts")
      f.page.error = { kind: "verification", message: "Human verification" }
      await expect(f.controller.browserCommand(owner, job.id, "click", { uid: "check" }, execute)).rejects.toThrow(
        "Human browser verification",
      )
      await expect(f.controller.browserCommand(owner, job.id, "scroll", {}, execute)).rejects.toThrow(
        "all agent browser mutations are blocked",
      )
      await expect(f.controller.browserCommand(owner, job.id, "close", {}, execute)).rejects.toThrow(
        "all agent browser mutations are blocked",
      )
      expect(dispatched).toBe(0)
    } finally {
      f.controller.dispose()
    }
  })
  test("finished results and config survive reload; pending sends are never replayed", async () => {
    const f = fixture()
    const job = await f.controller.command({ prompt: "Original" }, "main")
    await until(() => f.controller.list()[0].phase === "generating")
    f.controller.dispose()
    const next = fixture({ loaded: f.saved() })
    expect(next.controller.list()[0].phase).toBe("interrupted")
    expect(next.counts().submits).toBe(0)
    expect(next.controller.setConfig({ enabled: true, timeoutMinutes: 999 }).timeoutMinutes).toBe(60)
    expect(next.controller.list()[0].id).toBe(job.id)
    next.controller.dispose()
  })
  test("restart resumes a submitted attachment turn without reuploading or resending", async () => {
    const url = `${GPT_PRO_URL}c/restart`
    const file = {
      id: "restart-file",
      name: "restart.md",
      uploadName: "00000000-0000-0000-0000-000000000001-1-restart.md",
      path: "/source/restart.md",
      mime: "text/markdown",
      size: 10,
      sha256: "a".repeat(64),
      status: "ready" as const,
    }
    const job: GptProJob = {
      id: "gpt_00000000-0000-0000-0000-000000000001",
      owner: "/repo\nses_restart",
      requestID: "restart-attachments",
      phase: "interrupted",
      prompt: "Original attachment prompt",
      attachments: [file],
      stagedAttachments: [{ id: file.id, path: `/owned/${file.uploadName}`, sha256: file.sha256, uploadName: file.uploadName }],
      url,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      submitted: true,
      sendAttempted: true,
      userID: "user-existing",
      userCount: 0,
      model: "GPT-6 Pro",
      revision: 0,
      background: true,
    }
    let uploads = 0
    const f = fixture({
      loaded: [job],
      initialPage: {
        url,
        model: "GPT-6 Pro",
        targetModel: true,
        composer: true,
        draft: "",
        generating: true,
        revision: 0,
        users: [{
          id: "user-existing",
          text: "Original attachment prompt",
          attachments: [{ name: file.uploadName, kind: "document", status: "ready" }],
        }],
      },
      upload: async () => {
        uploads++
      },
    })
    await f.controller.command({ action: "resume", id: job.id })
    await until(() => f.controller.list()[0].phase === "generating")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(uploads).toBe(0)
    expect(f.counts().submits).toBe(0)
    f.controller.dispose()
  })
  test("captures the original conversation URL when the submitted prompt appears before image proof", async () => {
    const originalURL = `${GPT_PRO_URL}c/local-chatgpt%3A299df40d-c3ef-4a38-aac2-f54a0acde47a`
    const attachment = {
      id: "image-file",
      name: "pasted-image.png",
      uploadName: "00000000-0000-0000-0000-000000000002-1-pasted-image.png",
      mime: "image/png",
      size: 8,
      sha256: "b".repeat(64),
      status: "unknown" as const,
    }
    const job: GptProJob = {
      id: "gpt_00000000-0000-0000-0000-000000000002",
      owner: "/repo\nses_url_recovery",
      requestID: "pending-url-with-image",
      phase: "paused",
      recovery: { stage: "track", reason: "HTTP 403 cloudflare_challenge" },
      prompt: "Inspect the uploaded image",
      attachments: [attachment],
      stagedAttachments: [{
        id: attachment.id,
        path: `/owned/${attachment.uploadName}`,
        sha256: attachment.sha256,
        uploadName: attachment.uploadName,
      }],
      url: GPT_PRO_URL,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      submitted: true,
      sendAttempted: true,
      userCount: 0,
      model: "GPT-6 Pro",
      revision: 0,
      background: true,
    }
    const f = fixture({
      loaded: [job],
      initialPage: {
        url: originalURL,
        model: "GPT-6 Pro",
        targetModel: true,
        composer: true,
        draft: "",
        generating: false,
        revision: 0,
        error: { kind: "request", message: "Cloudflare challenge requires recovery" },
        users: [{
          id: "rendered-user",
          text: job.prompt,
          attachments: [{ name: "", kind: "image", status: "unknown" }],
        }],
      },
    })
    await until(() => f.controller.list()[0]?.phase === "paused")
    await f.controller.command({ action: "resume", id: job.id })
    await until(() => f.saved()[0]?.phase === "paused" && f.saved()[0]?.url === originalURL)
    expect(f.saved()[0].userID).toBeUndefined()
    expect(f.saved()[0].sendAttempted).toBe(true)
    expect(f.counts().submits).toBe(0)
    let navigated = false
    await expect(
      f.controller.browserCommand("/repo\nses_url_recovery", job.id, "navigate", { url: GPT_PRO_URL }, async () => {
        navigated = true
        return {}
      }),
    ).rejects.toThrow("preserve the original ChatGPT conversation")
    expect(navigated).toBe(false)
    f.controller.dispose()
  })
  test("retention cleanup removes only owned staging and keeps original sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-retention-"))
    const stagingRoot = path.join(root, "owned")
    const source = path.join(root, "original.txt")
    await writeFile(source, "keep original")
    try {
      const jobs: GptProJob[] = []
      for (let index = 0; index < 31; index++) {
        const suffix = String(index).padStart(12, "0")
        const id = `gpt_00000000-0000-0000-0000-${suffix}`
        const staged = path.join(stagingRoot, id, "file1", "original.txt")
        await mkdir(path.dirname(staged), { recursive: true })
        await writeFile(staged, "staged copy")
        jobs.push({
          id,
          owner: "test-owner",
          requestID: `retained-${index}`,
          phase: "completed",
          prompt: "Review file",
          attachments: [{
            id: "file1",
            name: "original.txt",
            uploadName: `retention-${index}-original.txt`,
            path: source,
            mime: "text/plain",
            size: 12,
            sha256: "a".repeat(64),
            status: "ready",
          }],
          stagedAttachments: [{ id: "file1", path: staged, sha256: "a".repeat(64), uploadName: `retention-${index}-original.txt` }],
          url: GPT_PRO_URL,
          createdAt: index,
          updatedAt: index,
          submitted: true,
          revision: 0,
        })
      }
      const f = fixture({ loaded: jobs, stagingRoot })
      await until(() => !existsSync(path.join(stagingRoot, jobs[0].id)))
      expect(await readFile(source, "utf8")).toBe("keep original")
      expect(f.controller.list()).toHaveLength(30)
      f.controller.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
