import { describe, expect, test } from "bun:test"
import {
  GptProController,
  type GptProDriverAPI,
  type GptProLifecycleOptions,
  type GptProManagedPage,
} from "./gpt-pro-controller"
import {
  GPT_PRO_URL,
  type GptProAttachment,
  type GptProConfig,
  type GptProJob,
  type GptProPageState,
} from "@opencode-ai/util/gpt-pro"
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
    preDispatchFailures?: number
    uploadDispatchGate?: () => Promise<void>
    hasPage?: () => boolean
    lifecycle?: GptProLifecycleOptions
    maxResidentPages?: number
    maxConcurrent?: number
  } = {},
) {
  let config: GptProConfig = {
    enabled: options.enabled ?? true,
    timeoutMinutes: 30,
    ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}),
    ...(options.maxResidentPages ? { maxResidentPages: options.maxResidentPages } : {}),
  }
  let saved: GptProJob[] = options.loaded ?? []
  let preDispatchFailures = options.preDispatchFailures ?? 0
  let submits = 0,
    stops = 0,
    fills = 0
  let disposedDrivers = 0
  const opens: Array<{ url: string; fresh: boolean }> = []
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
      opens.push({ url, fresh: fresh === true })
      await options.open?.()
      page.url = url
      if (fresh) {
        page.users = []
        page.answer = undefined
        page.answers = []
        page.draft = ""
      }
    },
    ready: async () => structuredClone(page),
    page: async () => structuredClone(page),
    observeModel: options.verify ?? (async () => structuredClone(page)),
    fill: async (prompt) => {
      fills++
      page.draft = prompt
    },
    submit: async (beforeDispatch) => {
      await options.submitGate?.()
      const commit = await beforeDispatch?.()
      commit?.()
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
    ...(options.hasPage ? { hasPage: options.hasPage } : {}),
    dispose: () => disposedDrivers++,
    ...(options.upload
      ? {
          uploadAttachments: (
            files: Array<{ path: string; name: string; mime?: string; sha256?: string }>,
            mayDispatch: boolean,
            shouldContinue?: () => Promise<boolean>,
            beforeDispatch?: () => Promise<void>,
          ) => {
            if (preDispatchFailures > 0) {
              preDispatchFailures--
              throw new Error("ChatGPT's verified attachment input is unavailable")
            }
            return (async () => {
              await options.uploadDispatchGate?.()
              await beforeDispatch?.()
              return options.upload!(files, mayDispatch, shouldContinue, (attachments) => {
                page.attachments = attachments
              })
            })()
          },
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
    options.lifecycle,
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
    page.answers = [
      ...(page.answers ?? []).filter((answer) => answer.userID !== user.id),
      {
        ...page.answer,
        generating: false,
        completionEvidence: "settled-marker",
      },
    ]
  }
  return {
    controller,
    page,
    finish,
    logs,
    opens,
    driver,
    counts: () => ({ submits, stops, fills }),
    disposals: () => disposedDrivers,
    saved: () => saved,
  }
}

function fakePageResources(graceMs = 30_000) {
  const pages = new Map<string, GptProManagedPage>()
  const states = new Map<string, GptProPageState>()
  const closed: Array<{ pageID: string; epoch: number; reason: string }> = []
  const focus: Array<{ pageID: string; epoch: number; enabled: boolean }> = []
  const closeListeners = new Set<(pageID: string, epoch: number, reason?: string) => void>()
  const protectionListeners = new Set<() => void>()
  const timers = new Map<number, () => void>()
  const scheduledDelays: number[] = []
  let nextTimer = 1
  const options: GptProLifecycleOptions = {
    graceMs,
    resources: {
      list: () => [...pages.values()].map((page) => ({ ...page })),
      inspect: async (pageID, epoch) => {
        if (pages.get(pageID)?.epoch !== epoch) throw new Error("stale page inspection")
        const state = states.get(pageID)
        if (!state) throw new Error("missing page inspection state")
        return structuredClone(state)
      },
      stop: async (pageID, epoch) => {
        if (pages.get(pageID)?.epoch !== epoch) throw new Error("stale page stop")
        const state = states.get(pageID)
        if (state) state.generating = false
      },
      close: (pageID, epoch, reason) => {
        if (pages.get(pageID)?.epoch !== epoch) return false
        pages.delete(pageID)
        states.delete(pageID)
        closed.push({ pageID, epoch, reason })
        for (const listener of closeListeners) listener(pageID, epoch, reason)
        return true
      },
      setFocus: async (pageID, epoch, enabled) => {
        focus.push({ pageID, epoch, enabled })
        return pages.get(pageID)?.epoch === epoch
      },
      onClosed: (listener) => {
        closeListeners.add(listener)
        return () => closeListeners.delete(listener)
      },
      onProtectionChanged: (listener) => {
        protectionListeners.add(listener)
        return () => protectionListeners.delete(listener)
      },
    },
    setTimeout: ((callback: (...args: unknown[]) => void, delay: number) => {
      const id = nextTimer++
      scheduledDelays.push(delay)
      timers.set(id, () => callback())
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimeout: ((handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number)
    }) as typeof clearTimeout,
  }
  return {
    options,
    pages,
    states,
    closed,
    focus,
    timers,
    scheduledDelays,
    add(page: GptProManagedPage, state: GptProPageState) {
      pages.set(page.pageID, { ...page })
      states.set(page.pageID, structuredClone(state))
    },
    protect(pageID: string, protectedPage: boolean) {
      const page = pages.get(pageID)
      if (!page) return
      pages.set(pageID, { ...page, protected: protectedPage })
      for (const listener of protectionListeners) listener()
    },
    fireNext() {
      const first = timers.entries().next().value as [number, () => void] | undefined
      if (!first) return false
      timers.delete(first[0])
      first[1]()
      return true
    },
  }
}

function multiPageFixture(
  maxConcurrent = 4,
  failOwner?: string,
  beforePageRead?: (jobID: string, page: GptProPageState) => Promise<void>,
  lifecycle?: GptProLifecycleOptions,
  onOpened?: (jobID: string, url: string, fresh: boolean) => void,
  loaded?: GptProJob[],
) {
  let config: GptProConfig = { enabled: true, timeoutMinutes: 30, maxConcurrent }
  let saved: GptProJob[] = loaded ?? []
  const logs: string[] = []
  const pages = new Map<string, GptProPageState>()
  const drivers = new Map<string, GptProDriverAPI>()
  const controller = new GptProController(
    (job) => {
      const page: GptProPageState = {
        url: GPT_PRO_URL,
        model: "Website selection",
        targetModel: false,
        composer: true,
        draft: "",
        generating: false,
        revision: 0,
        users: [],
        answers: [],
      }
      pages.set(job.id, page)
      const driver: GptProDriverAPI = {
        open: async (url = GPT_PRO_URL, fresh) => {
          if (job.owner === failOwner) throw new Error("simulated page failure")
          page.url = url
          if (fresh) page.users = []
          onOpened?.(job.id, url, fresh === true)
        },
        ready: async () => structuredClone(page),
        page: async () => {
          await beforePageRead?.(job.id, page)
          return structuredClone(page)
        },
        observeModel: async () => {
          await beforePageRead?.(job.id, page)
          return structuredClone(page)
        },
        fill: async (prompt) => {
          page.draft = prompt
        },
        submit: async (beforeDispatch) => {
          const commit = await beforeDispatch?.()
          commit?.()
          const user = { id: `user-${job.id}`, text: page.draft }
          page.users.push(user)
          page.draft = ""
          page.generating = true
          page.url = `${GPT_PRO_URL}c/${job.id}`
          page.answers = []
        },
        stop: async () => {
          page.generating = false
        },
      }
      drivers.set(job.id, driver)
      return driver
    },
    {
      load: () => saved,
      save: (jobs) => {
        saved = structuredClone(jobs)
      },
      config: () => config,
      setConfig: (next) => {
        config = next
      },
    },
    (message) => logs.push(message),
    1,
    1,
    lifecycle,
  )
  const finish = (id: string, text: string) => {
    const page = pages.get(id)!
    const user = page.users.at(-1)!
    page.generating = false
    page.answers = [
      {
        id: `answer-${id}`,
        userID: user.id,
        text,
        html: `<p>${text}</p>`,
        complete: true,
        truncated: false,
        generating: false,
        completionEvidence: "settled-marker",
      },
    ]
  }
  return { controller, pages, drivers, finish, logs, saved: () => saved }
}

async function previewJob(
  root: string,
  options: { id?: string; attachmentID?: string; phase?: GptProJob["phase"] } = {},
) {
  const id = options.id ?? "gpt_00000000-0000-0000-0000-000000000099"
  const attachmentID = options.attachmentID ?? "preview-file"
  const name = "preview.txt"
  const uploadName = `${id.slice(4)}-1-${name}`
  const source = path.join(root, `source-${id}.txt`)
  const stagingRoot = path.join(root, "owned")
  const stagedPath = path.join(stagingRoot, id, attachmentID, uploadName)
  const bytes = Buffer.from(`preview payload for ${id}`)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  await mkdir(path.dirname(stagedPath), { recursive: true })
  await Promise.all([writeFile(source, bytes), writeFile(stagedPath, bytes)])
  const job: GptProJob = {
    id,
    owner: "owner",
    requestID: `preview-${id}`,
    phase: options.phase ?? "completed",
    prompt: "Review this attachment",
    attachments: [
      {
        id: attachmentID,
        name,
        uploadName,
        path: source,
        mime: "text/plain",
        size: bytes.byteLength,
        sha256,
        status: "ready",
      },
    ],
    stagedAttachments: [{ id: attachmentID, path: stagedPath, sha256, uploadName }],
    url: GPT_PRO_URL,
    createdAt: 1,
    updatedAt: 1,
    submitted: true,
    revision: 1,
  }
  return { job, bytes, stagingRoot, source, stagedPath, attachmentID }
}

describe("gpt-pro consultation control", () => {
  test("runs two owners concurrently on distinct pages sharing the GPT-Pro profile", async () => {
    const f = multiPageFixture(2)
    const ownerA = "/repo\nses_parallel_a"
    const ownerB = "/repo\nses_parallel_b"
    try {
      const [a, b] = await Promise.all([
        f.controller.command({ requestID: "parallel-a", prompt: "Question A" }, ownerA),
        f.controller.command({ requestID: "parallel-b", prompt: "Question B" }, ownerB),
      ])
      await until(() => f.pages.get(a.id)?.generating === true && f.pages.get(b.id)?.generating === true)
      expect(a.pageID).toBe(`gpt-pro-page-${a.id}`)
      expect(b.pageID).toBe(`gpt-pro-page-${b.id}`)
      expect(a.pageID).not.toBe(b.pageID)
      expect(a.profileID).toBe(b.profileID)
      expect(a.ownerPage).toEqual({ directory: "/repo", sessionID: "ses_parallel_a" })
      expect(b.ownerPage).toEqual({ directory: "/repo", sessionID: "ses_parallel_b" })
      expect(f.pages.get(a.id)?.users[0]?.text).toBe("Question A")
      expect(f.pages.get(b.id)?.users[0]?.text).toBe("Question B")
      f.finish(a.id, "Answer A")
      f.finish(b.id, "Answer B")
      await until(() => f.controller.list().every((job) => job.phase === "completed"))
      expect(f.controller.list().map((job) => job.pageID)).toEqual([a.pageID, b.pageID])
    } finally {
      f.controller.dispose()
    }
  })
  test("a paused page releases its bounded scheduler slot for another owner", async () => {
    const ownerA = "/repo\nses_pause_a"
    const ownerB = "/repo\nses_pause_b"
    const f = multiPageFixture(1, ownerA)
    try {
      const first = await f.controller.command({ requestID: "paused-a", prompt: "Question A" }, ownerA)
      await until(() => f.controller.list().find((job) => job.id === first.id)?.phase === "paused")
      const second = await f.controller.command({ requestID: "after-pause-b", prompt: "Question B" }, ownerB)
      await until(() => f.pages.get(second.id)?.generating === true)
      expect(f.controller.list().find((job) => job.id === first.id)?.phase).toBe("paused")
      expect(f.controller.list().find((job) => job.id === second.id)?.phase).toBe("generating")
      f.finish(second.id, "Answer B")
      await until(() => f.controller.list().find((job) => job.id === second.id)?.phase === "completed")
    } finally {
      f.controller.dispose()
    }
  })
  test("queued jobs report capacity separately from owner contention", async () => {
    const ownerA = "/repo\nses_capacity_a"
    const ownerB = "/repo\nses_capacity_b"
    let firstAdmission = true
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const started = new Promise<void>((resolve) => (entered = resolve))
    const f = multiPageFixture(1, undefined, async (_jobID, page) => {
      if (!firstAdmission || page.generating) return
      firstAdmission = false
      entered()
      await gate
    })
    try {
      const first = await f.controller.command({ requestID: "capacity-a", prompt: "Question A" }, ownerA)
      await started
      const second = await f.controller.command({ requestID: "capacity-b", prompt: "Question B" }, ownerB)
      await until(() => f.controller.list().find((job) => job.id === second.id)?.queueReason === "capacity")
      expect(f.controller.list().find((job) => job.id === second.id)?.queueOwnerConsultationID).toBeUndefined()
      release()
      await until(() => f.pages.get(first.id)?.generating === true)
      f.finish(first.id, "Answer A")
      await until(() => f.pages.get(second.id)?.generating === true)
      expect(f.controller.list().find((job) => job.id === second.id)?.queueReason).toBeUndefined()
      f.finish(second.id, "Answer B")
      await until(() => f.controller.list().every((job) => job.phase === "completed"))
    } finally {
      release()
      f.controller.dispose()
    }
  })
  test("evicts an inspected hidden terminal page before allocating a page at the resident limit", async () => {
    const resources = fakePageResources()
    const old: GptProJob = {
      id: "gpt_old_terminal",
      owner: "/repo\nses_old_terminal",
      requestID: "old-terminal",
      phase: "completed",
      prompt: "Old question",
      url: GPT_PRO_URL,
      createdAt: 1,
      updatedAt: 1,
      submitted: false,
      revision: 1,
    }
    resources.add(
      { pageID: `gpt-pro-page-${old.id}`, epoch: 3, lastActivity: 1, protected: false },
      { url: GPT_PRO_URL, composer: true, draft: "", generating: false, revision: 0, users: [] },
    )
    const f = fixture({ loaded: [old], lifecycle: resources.options, maxConcurrent: 1, maxResidentPages: 1 })
    try {
      const next = await f.controller.command({ prompt: "New question" }, "/repo\nses_new_terminal")
      await until(() => resources.closed.length === 1)
      await until(() => f.controller.list().find((job) => job.id === next.id)?.phase === "generating")
      expect(resources.closed[0]).toMatchObject({
        pageID: old.pageID ?? `gpt-pro-page-${old.id}`,
        epoch: 3,
        reason: "resident-budget-eviction",
      })
      expect(resources.pages.has(`gpt-pro-page-${old.id}`)).toBe(false)
    } finally {
      f.controller.dispose()
    }
  })
  test("stop during a pending resident allocation cannot revive or send the cancelled job", async () => {
    for (const cancelOwner of [false, true]) {
      const resources = fakePageResources()
      const old: GptProJob = {
        id: "gpt_old_allocation",
        owner: "/repo\nses_old_allocation",
        requestID: "old-allocation",
        phase: "completed",
        prompt: "Old question",
        url: GPT_PRO_URL,
        createdAt: 1,
        updatedAt: 1,
        submitted: false,
        revision: 1,
      }
      resources.add(
        { pageID: `gpt-pro-page-${old.id}`, epoch: 1, lastActivity: 1, protected: false },
        { url: GPT_PRO_URL, composer: true, draft: "", generating: false, revision: 0, users: [] },
      )
      let entered = false
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const inspect = resources.options.resources.inspect
      resources.options.resources.inspect = async (...args) => {
        entered = true
        await gate
        return inspect(...args)
      }
      const f = fixture({ loaded: [old], lifecycle: resources.options, maxConcurrent: 1, maxResidentPages: 1 })
      const owner = "/repo\nses_cancel_allocation"
      try {
        const job = await f.controller.command({ prompt: "Never send after stop" }, owner)
        await until(() => entered)
        if (cancelOwner) f.controller.cancelOwner(owner)
        else await f.controller.command({ action: "stop", id: job.id }, owner)
        const fresh = await f.controller.command({ prompt: "Fresh request remains allowed" }, owner)
        release()
        await until(() => f.logs.some((line) => line.includes("stale allocation skipped")))
        expect((await f.controller.command({ action: "read", id: job.id }, owner)).phase).toBe("cancelled")
        expect(f.page.users.some((user) => user.text === "Never send after stop")).toBe(false)
        expect(f.logs.some((line) => line.includes("reason=dispatch-eligibility-changed"))).toBe(true)
        await until(() => f.controller.list().find((item) => item.id === fresh.id)?.phase === "generating")
        expect(f.counts().submits).toBe(1)
      } finally {
        release()
        f.controller.dispose()
      }
    }
  })
  test("refuses to evict terminal pages containing manual state and reports page capacity", async () => {
    for (const state of [
      { url: GPT_PRO_URL, composer: true, draft: "Manual follow-up", generating: false, revision: 0, users: [] },
      { url: GPT_PRO_URL, composer: true, draft: "", generating: true, revision: 0, users: [] },
      { url: `${GPT_PRO_URL}c/unrelated`, composer: true, draft: "", generating: false, revision: 0, users: [] },
    ]) {
      const resources = fakePageResources()
      const old: GptProJob = {
        id: `gpt_protected_${resources.pages.size}_${Math.random().toString(16).slice(2)}`,
        owner: "/repo\nses_terminal_manual",
        requestID: "terminal-manual",
        phase: "completed",
        prompt: "Old question",
        url: GPT_PRO_URL,
        createdAt: 1,
        updatedAt: 1,
        submitted: false,
        revision: 1,
      }
      const pageID = `gpt-pro-page-${old.id}`
      resources.add({ pageID, epoch: 1, lastActivity: 1, protected: false }, state)
      const f = fixture({ loaded: [old], lifecycle: resources.options, maxConcurrent: 1, maxResidentPages: 1 })
      try {
        const next = await f.controller.command({ prompt: "Wait for a page" }, "/repo\nses_waiting_page")
        await until(() => f.controller.list().find((job) => job.id === next.id)?.queueReason === "page_capacity")
        expect(resources.closed).toHaveLength(0)
        expect(resources.pages.has(pageID)).toBe(true)
        expect(resources.focus.some((item) => !item.enabled)).toBe(false)
      } finally {
        f.controller.dispose()
      }
    }
  })
  test("protected and recoverable pages consume resident budget without being evicted", async () => {
    const resources = fakePageResources()
    const protectedJob: GptProJob = {
      id: "gpt_visible_terminal",
      owner: "/repo\nses_visible_terminal",
      requestID: "visible-terminal",
      phase: "completed",
      prompt: "Viewed result",
      url: GPT_PRO_URL,
      createdAt: 1,
      updatedAt: 1,
      submitted: false,
      revision: 1,
    }
    const paused: GptProJob = {
      ...protectedJob,
      id: "gpt_hidden_paused",
      requestID: "hidden-paused",
      phase: "paused",
      recovery: { stage: "compose", reason: "manual recovery" },
    }
    resources.add(
      { pageID: `gpt-pro-page-${protectedJob.id}`, epoch: 1, lastActivity: 1, protected: true },
      { url: GPT_PRO_URL, composer: true, draft: "", generating: false, revision: 0, users: [] },
    )
    resources.add(
      { pageID: `gpt-pro-page-${paused.id}`, epoch: 1, lastActivity: 2, protected: false },
      { url: GPT_PRO_URL, composer: true, draft: "", generating: false, revision: 0, users: [] },
    )
    const f = fixture({
      loaded: [protectedJob, paused],
      lifecycle: resources.options,
      maxConcurrent: 2,
      maxResidentPages: 2,
    })
    try {
      const next = await f.controller.command({ prompt: "Third page" }, "/repo\nses_page_limit")
      await until(() => f.controller.list().find((job) => job.id === next.id)?.queueReason === "page_capacity")
      expect(resources.closed).toHaveLength(0)
      expect(resources.pages.size).toBe(2)
      expect(resources.timers.size).toBe(0)
    } finally {
      f.controller.dispose()
    }
  })
  test("serialized page reservations prevent concurrent opens exceeding the resident budget", async () => {
    const resources = fakePageResources()
    const viewed: GptProJob = {
      id: "gpt_viewed_resident",
      owner: "/repo\nses_viewed_resident",
      requestID: "viewed-resident",
      phase: "completed",
      prompt: "Viewed answer",
      url: GPT_PRO_URL,
      createdAt: 1,
      updatedAt: 1,
      submitted: false,
      revision: 1,
    }
    resources.add(
      { pageID: `gpt-pro-page-${viewed.id}`, epoch: 1, lastActivity: 1, protected: true },
      { url: GPT_PRO_URL, composer: true, draft: "", generating: false, revision: 0, users: [] },
    )
    let f!: ReturnType<typeof multiPageFixture>
    f = multiPageFixture(
      2,
      undefined,
      undefined,
      resources.options,
      (jobID) => {
        const pageID = `gpt-pro-page-${jobID}`
        const page = f.pages.get(jobID)!
        resources.add({ pageID, epoch: 1, lastActivity: Date.now(), protected: false }, page)
      },
      [viewed],
    )
    f.controller.setConfig({ enabled: true, timeoutMinutes: 30, maxConcurrent: 2, maxResidentPages: 2 })
    try {
      const [first, second] = await Promise.all([
        f.controller.command({ prompt: "First allocation" }, "/repo\nses_first_allocation"),
        f.controller.command({ prompt: "Second allocation" }, "/repo\nses_second_allocation"),
      ])
      await until(() => {
        const state = f.controller.list().find((job) => job.id === second.id)
        return !!state?.queueReason || state?.phase !== "queued"
      })
      expect(f.controller.list().find((job) => job.id === second.id)?.phase).toBe("queued")
      expect(f.controller.list().find((job) => job.id === second.id)?.queueReason).toBe("page_capacity")
      expect(resources.pages.size).toBe(2)
      expect(resources.pages.has(`gpt-pro-page-${viewed.id}`)).toBe(true)
      expect(resources.pages.has(first.pageID!)).toBe(true)
      expect(f.controller.list().find((job) => job.id === first.id)?.phase).toMatch(/preparing|sending|generating/)
    } finally {
      f.controller.dispose()
    }
  })
  test("a closed consultation page makes only its job uncertain", async () => {
    const ownerA = "/repo\nses_closed_a"
    const ownerB = "/repo\nses_closed_b"
    let closedID = ""
    const f = multiPageFixture(2, undefined, async (jobID, page) => {
      if (jobID === closedID && page.generating) throw new Error("consultation WebContents closed")
    })
    try {
      const first = await f.controller.command({ requestID: "closed-a", prompt: "Question A" }, ownerA)
      closedID = first.id
      const second = await f.controller.command({ requestID: "open-b", prompt: "Question B" }, ownerB)
      await until(
        () =>
          f.controller.list().find((job) => job.id === first.id)?.phase === "send_uncertain" &&
          f.pages.get(second.id)?.generating === true,
      )
      expect(f.controller.list().find((job) => job.id === first.id)?.pageID).toBe(first.pageID)
      expect(f.controller.list().find((job) => job.id === second.id)?.phase).toBe("generating")
      f.finish(second.id, "Answer B")
      await until(() => f.controller.list().find((job) => job.id === second.id)?.phase === "completed")
    } finally {
      f.controller.dispose()
    }
  })
  test("rejects a second unfinished consultation for the same owner until cancellation", async () => {
    const f = multiPageFixture(2)
    const owner = "/repo\nses_owner_busy"
    try {
      const first = await f.controller.command({ requestID: "owner-first", prompt: "First" }, owner)
      await until(() => f.controller.list().find((job) => job.id === first.id)?.phase === "generating")
      await expect(f.controller.command({ requestID: "owner-second", prompt: "Second" }, owner)).rejects.toThrow(
        `owner_page_busy: consultation ${first.id} is still generating`,
      )
      await f.controller.command({ action: "stop", id: first.id }, owner)
      const second = await f.controller.command({ requestID: "owner-second", prompt: "Second" }, owner)
      expect(second.pageID).not.toBe(first.pageID)
      await until(() => f.pages.get(second.id)?.generating === true)
    } finally {
      f.controller.dispose()
    }
  })
  test("owner cancellation stops that owner's paused background job without touching another owner", async () => {
    const f = multiPageFixture(2)
    const ownerA = "/repo\nses_stop_a"
    const ownerB = "/repo\nses_stop_b"
    try {
      const [a, b] = await Promise.all([
        f.controller.command({ requestID: "background-a", prompt: "Question A", background: true }, ownerA),
        f.controller.command({ requestID: "foreground-b", prompt: "Question B" }, ownerB),
      ])
      await until(() => f.pages.get(a.id)?.generating === true && f.pages.get(b.id)?.generating === true)
      await f.controller.command({ action: "pause", id: a.id }, ownerA)
      expect(f.controller.list().find((job) => job.id === a.id)?.phase).toBe("paused")
      expect(f.controller.list().find((job) => job.id === a.id)?.background).toBe(true)
      expect(f.controller.cancelOwner(ownerA)).toBe(1)
      expect(f.controller.list().find((job) => job.id === a.id)?.phase).toBe("cancelled")
      expect(f.controller.list().find((job) => job.id === b.id)?.phase).toBe("generating")
      expect(f.pages.get(b.id)?.generating).toBe(true)
      await f.controller.command({ action: "stop", id: b.id }, ownerB)
    } finally {
      f.controller.dispose()
    }
  })
  test("stopping a settled paused job uses its live page lease after the runner driver is released", async () => {
    for (const cancelOwner of [false, true]) {
      const resources = fakePageResources()
      let f!: ReturnType<typeof multiPageFixture>
      f = multiPageFixture(2, undefined, undefined, resources.options, (jobID) => {
        const pageID = `gpt-pro-page-${jobID}`
        const page = f.pages.get(jobID)!
        resources.add({ pageID, epoch: 1, lastActivity: Date.now(), protected: false }, page)
        resources.states.set(pageID, page)
      })
      const ownerA = "/repo\nses_stop_released_a"
      const ownerB = "/repo\nses_stop_released_b"
      try {
        const a = await f.controller.command({ prompt: "Question A", background: true }, ownerA)
        const b = await f.controller.command({ prompt: "Question B" }, ownerB)
        await until(() => f.pages.get(a.id)?.generating === true && f.pages.get(b.id)?.generating === true)
        await f.controller.command({ action: "pause", id: a.id }, ownerA)
        await until(() => f.logs.some((line) => line.includes(`execution resources released id=${a.id}`)))
        expect(f.pages.get(a.id)?.generating).toBe(true)
        if (cancelOwner) f.controller.cancelOwner(ownerA)
        else await f.controller.command({ action: "stop", id: a.id }, ownerA)
        await until(() => f.pages.get(a.id)?.generating === false)
        await until(() => f.logs.some((line) => line.includes(`native stop settled id=${a.id}`)))
        expect(f.controller.list().find((item) => item.id === a.id)?.phase).toBe("cancelled")
        expect(f.pages.get(b.id)?.generating).toBe(true)
        expect(f.controller.list().find((item) => item.id === b.id)?.phase).toBe("generating")
        expect(resources.pages.size).toBe(2)
        expect(
          f.logs.some((line) => line.includes(`native stop settled id=${a.id}`) && line.includes("outcome=stopped")),
        ).toBe(true)
      } finally {
        f.controller.dispose()
      }
    }
  })
  test("paused unsent login recovery can import login without cancelling or automatically sending", async () => {
    const job: GptProJob = { id: "gpt_login_wait", owner: "/repo\nses_login_wait", requestID: "login-wait", phase: "paused",
      prompt: "Original question", url: GPT_PRO_URL, createdAt: 1, updatedAt: 1, submitted: false, revision: 0,
      recovery: { stage: "ready", reason: "Sign in to ChatGPT", needsHuman: true } }
    const f = fixture({ loaded: [job] })
    let imported = 0
    try {
      await f.controller.importLogin(async () => { imported++ })
      expect(imported).toBe(1)
      expect(f.controller.list()[0].phase).toBe("paused")
      expect(f.controller.list()[0].prompt).toBe(job.prompt)
      expect(f.counts().submits).toBe(0)
    } finally { f.controller.dispose() }
  })
  test("already-sent paused jobs protect their shared account from replacement", async () => {
    const job: GptProJob = { id: "gpt_login_sent", owner: "/repo\nses_login_sent", requestID: "login-sent", phase: "paused",
      prompt: "Original question", url: GPT_PRO_URL, createdAt: 1, updatedAt: 1, submitted: true, userID: "user", revision: 0 }
    const f = fixture({ loaded: [job] })
    let imported = 0
    try {
      await expect(f.controller.importLogin(async () => { imported++ })).rejects.toThrow("login_import_busy")
      expect(imported).toBe(0)
      expect(f.controller.list()[0].phase).toBe("paused")
    } finally { f.controller.dispose() }
  })
  test("new consultations cannot dispatch while cookie import is in progress", async () => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const importing = f.controller.importLogin(async () => { await gate })
    try {
      const job = await f.controller.command({ prompt: "Wait for import" }, "/repo\nses_import_queue")
      expect(f.controller.list().find((item) => item.id === job.id)).toMatchObject({ phase: "queued", queueReason: "login_import" })
      expect(f.opens).toHaveLength(0)
      expect(f.counts().submits).toBe(0)
      await expect(f.controller.importLogin(async () => {})).rejects.toThrow("login_import_busy")
      release()
      await importing
      await until(() => f.page.generating)
      expect(f.counts().submits).toBe(1)
    } finally { release(); await importing; f.controller.dispose() }
  })
  test("failed login import releases the scheduling lock", async () => {
    const f = fixture()
    try {
      await expect(f.controller.importLogin(async () => { throw Error("Import failed") })).rejects.toThrow("Import failed")
      await f.controller.importLogin(async () => {})
      await f.controller.command({ prompt: "Fresh question" }, "/repo\nses_import_unlock")
      await until(() => f.page.generating)
      expect(f.counts().submits).toBe(1)
    } finally { f.controller.dispose() }
  })
  test("native stop failure is persisted as a warning without undoing local cancellation", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const f = fixture({
      stop: async () => {
        await gate
        throw new Error("Stop control unavailable")
      },
    })
    try {
      const job = await f.controller.command({ prompt: "Stop safely" }, "/repo\nses_stop_warning")
      await until(() => f.page.generating)
      const stopped = await f.controller.command({ action: "stop", id: job.id })
      expect(stopped.phase).toBe("cancelled")
      expect(stopped.stopPending).toBe(true)
      release()
      await until(() => f.saved().find((item) => item.id === job.id)?.errorCode === "stop_unconfirmed")
      const saved = await f.controller.command({ action: "read", id: job.id })
      expect(saved.phase).toBe("cancelled")
      expect(saved.stopPending).toBe(false)
      expect(saved.error).toContain("stopped locally")
      expect(f.counts().submits).toBe(1)
      await expect(f.controller.command({ action: "resume", id: job.id })).rejects.toThrow("Cannot resume")
    } finally {
      release()
      f.controller.dispose()
    }
  })
  test("restart does not leave cancelled consultations polling an unfinished native stop", () => {
    const job: GptProJob = {
      id: "gpt_restart_stop", owner: "main", requestID: "restart-stop", phase: "cancelled",
      prompt: "Stopped question", url: GPT_PRO_URL, createdAt: 1, updatedAt: 1,
      submitted: true, userID: "user-original", revision: 1, stopPending: true,
    }
    const f = fixture({ loaded: [job] })
    try {
      expect(f.controller.list()[0]).toMatchObject({ phase: "cancelled", stopPending: false, errorCode: "stop_unconfirmed" })
      expect(f.opens).toHaveLength(0)
      expect(f.counts().submits).toBe(0)
    } finally { f.controller.dispose() }
  })
  test("history retention keeps an old terminal job until its native stop settles", async () => {
    const resources = fakePageResources()
    const old: GptProJob = {
      id: "gpt_stop_retention", owner: "main", requestID: "stop-retention", phase: "paused",
      prompt: "Original question", url: GPT_PRO_URL, createdAt: 0, updatedAt: 0,
      submitted: false, revision: 0,
    }
    const completed = Array.from({ length: 31 }, (_, index) => ({ ...old, id: `gpt_stop_history_${index}`, phase: "completed" as const }))
    resources.add({ pageID: `gpt-pro-page-${old.id}`, epoch: 1, lastActivity: 1, protected: false },
      { url: GPT_PRO_URL, model: "", targetModel: false, composer: true, draft: "", generating: false, revision: 0, users: [] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    resources.options.resources.stop = async () => { await gate; throw Error("Native stop unavailable") }
    const f = fixture({ loaded: [old, ...completed], lifecycle: resources.options })
    try {
      await f.controller.command({ action: "stop", id: old.id })
      expect(f.saved().some((job) => job.id === old.id && job.stopPending)).toBe(true)
      expect(f.controller.list().filter((job) => job.phase === "completed")).toHaveLength(30)
    } finally {
      release()
      f.controller.dispose()
    }
  })
  test("owner cancellation revokes an in-flight consultation creation before admission", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-stop-stage-"))
    const attachmentPath = path.join(root, "note.md")
    const bytes = Buffer.from("owner scoped staging")
    await writeFile(attachmentPath, bytes)
    const owner = "/repo\nses_stop_stage"
    const f = fixture({ stagingRoot: path.join(root, "owned") })
    let entered!: () => void
    let release!: () => void
    const stagingEntered = new Promise<void>((resolve) => (entered = resolve))
    const stagingGate = new Promise<void>((resolve) => (release = resolve))
    const controller = f.controller as unknown as {
      stageAttachments: (
        jobID: string,
        attachments: GptProAttachment[],
      ) => Promise<NonNullable<GptProJob["stagedAttachments"]>>
    }
    const stage = controller.stageAttachments.bind(f.controller)
    controller.stageAttachments = async (jobID, attachments) => {
      entered()
      await stagingGate
      return stage(jobID, attachments)
    }
    try {
      const creating = f.controller.command(
        {
          requestID: "stop-before-admission",
          prompt: "Review this file",
          attachments: [
            {
              id: "stop-file",
              name: "note.md",
              path: attachmentPath,
              mime: "text/markdown",
              size: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
        },
        owner,
      )
      await stagingEntered
      expect(f.controller.cancelOwner(owner)).toBe(0)
      release()
      await expect(creating).rejects.toThrow("owner_session_cancelled")
      expect(f.controller.list()).toHaveLength(0)
      expect(f.counts().submits).toBe(0)
      const fresh = await f.controller.command(
        { requestID: "fresh-after-stop", prompt: "Fresh explicit request" },
        owner,
      )
      expect(fresh.pageID).toBe(`gpt-pro-page-${fresh.id}`)
      expect(f.controller.list()).toHaveLength(1)
      await f.controller.command({ action: "stop", id: fresh.id }, owner)
    } finally {
      release()
      f.controller.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  test("a cancelled result can be opened read-only without sending again", async () => {
    const f = fixture()
    const owner = "/repo\nses_cancelled_open"
    try {
      const job = await f.controller.command({ prompt: "Keep this result" }, owner)
      await until(() => f.controller.list()[0]?.userID !== undefined)
      const stopped = await f.controller.command({ action: "stop", id: job.id }, owner)
      expect(stopped.phase).toBe("cancelled")
      const before = f.counts()
      const opened = await f.controller.command({ action: "open", id: job.id }, owner)
      expect(opened.phase).toBe("cancelled")
      expect(f.page.url).toBe(opened.url)
      expect(f.page.users[0]?.text).toBe("Keep this result")
      expect(f.counts().submits).toBe(before.submits)
      expect(f.counts().fills).toBe(before.fills)
    } finally {
      f.controller.dispose()
    }
  })
  test("restart preserves paused jobs and marks unconfirmed sends uncertain without pumping", async () => {
    const base = {
      owner: "/repo\nses_restart",
      requestID: "restart",
      prompt: "Original question",
      url: GPT_PRO_URL,
      createdAt: 1,
      updatedAt: 1,
      submitted: false,
      revision: 0,
    }
    const paused: GptProJob = {
      ...base,
      id: "gpt_paused",
      phase: "paused",
      recovery: { stage: "compose", reason: "Inspect" },
    }
    const uncertain: GptProJob = {
      ...base,
      id: "gpt_uncertain",
      phase: "sending",
      submitted: true,
      sendAttempted: true,
    }
    const f = multiPageFixture(2)
    f.controller.dispose()
    const loaded = new GptProController(
      () => {
        throw new Error("Restarted jobs must not acquire a driver before an explicit action")
      },
      {
        load: () => [paused, uncertain],
        save: () => {},
        config: () => ({ enabled: true, timeoutMinutes: 30, maxConcurrent: 2 }),
        setConfig: () => {},
      },
      () => {},
      1,
      1,
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const jobs = loaded.list()
      expect(jobs.find((job) => job.id === paused.id)?.phase).toBe("paused")
      expect(jobs.find((job) => job.id === uncertain.id)?.phase).toBe("send_uncertain")
      expect(jobs.find((job) => job.id === paused.id)?.pageID).toBe(`gpt-pro-page-${paused.id}`)
    } finally {
      loaded.dispose()
    }
  })
  test("legacy same-owner confirmed background jobs queue deterministically while other owners proceed", async () => {
    const ownerA = "/repo\nses_legacy_queue"
    const ownerB = "/repo\nses_unrelated_queue"
    const job = (id: string, owner: string, createdAt: number): GptProJob => ({
      id,
      owner,
      requestID: id,
      phase: "interrupted",
      prompt: `Prompt ${id}`,
      url: `${GPT_PRO_URL}c/${id}`,
      createdAt,
      updatedAt: createdAt,
      submitted: true,
      sendAttempted: true,
      userID: `user-${id}`,
      userCount: 0,
      revision: 0,
      background: true,
    })
    const first = job("gpt_legacy_first", ownerA, 1)
    const second = job("gpt_legacy_second", ownerA, 2)
    const unrelated = job("gpt_legacy_other", ownerB, 3)
    const started: string[] = []
    let saved: GptProJob[] = [first, second, unrelated]
    const controller = new GptProController(
      (stored) => {
        started.push(stored.id)
        const page: GptProPageState = {
          url: stored.url,
          model: "Website selection",
          targetModel: false,
          composer: true,
          draft: "",
          generating: true,
          revision: 0,
          users: [{ id: stored.userID!, text: stored.prompt }],
          answers: [],
        }
        return {
          open: async () => {},
          ready: async () => structuredClone(page),
          page: async () => structuredClone(page),
          observeModel: async () => structuredClone(page),
          fill: async () => {
            throw new Error("confirmed background tracking must not fill")
          },
          submit: async () => {
            throw new Error("confirmed background tracking must not submit")
          },
          stop: async () => {},
        }
      },
      {
        load: () => saved,
        save: (jobs) => {
          saved = structuredClone(jobs)
        },
        config: () => ({ enabled: true, timeoutMinutes: 30, maxConcurrent: 2 }),
        setConfig: () => {},
      },
      () => {},
      1,
      1,
    )
    try {
      await until(() => started.includes(first.id) && started.includes(unrelated.id))
      const queued = controller.list().find((item) => item.id === second.id)!
      expect(queued.phase).toBe("queued")
      expect(queued.queueReason).toBe("owner_busy")
      expect(queued.queueOwnerConsultationID).toBe(first.id)
      expect(started).not.toContain(second.id)
    } finally {
      controller.dispose()
    }
  })
  test("retention never prunes recoverable paused or uncertain jobs", async () => {
    const completed = Array.from(
      { length: 35 },
      (_, index): GptProJob => ({
        id: `gpt_completed_${index}`,
        owner: `/repo\nses_${index}`,
        requestID: `completed-${index}`,
        phase: "completed",
        prompt: `Question ${index}`,
        url: GPT_PRO_URL,
        createdAt: index,
        updatedAt: index,
        submitted: true,
        revision: 0,
      }),
    )
    const paused: GptProJob = {
      id: "gpt_recoverable_paused",
      owner: "/repo\nses_paused",
      requestID: "paused",
      phase: "paused",
      recovery: { stage: "compose", reason: "manual recovery" },
      prompt: "Keep me",
      url: GPT_PRO_URL,
      createdAt: 100,
      updatedAt: 100,
      submitted: false,
      revision: 0,
      stagedAttachments: [{ id: "owned", path: "/owned/file.txt", sha256: "a".repeat(64), uploadName: "file.txt" }],
    }
    const uncertain: GptProJob = {
      ...paused,
      id: "gpt_recoverable_uncertain",
      requestID: "uncertain",
      phase: "send_uncertain",
      recovery: undefined,
      sendAttempted: true,
    }
    let persisted: GptProJob[] = []
    const controller = new GptProController(
      () => {
        throw new Error("terminal retained jobs must not acquire page drivers")
      },
      {
        load: () => [...completed, paused, uncertain],
        save: (jobs) => {
          persisted = structuredClone(jobs)
        },
        config: () => ({ enabled: true, timeoutMinutes: 30 }),
        setConfig: () => {},
      },
      () => {},
      1,
      1,
    )
    try {
      expect(persisted.filter((job) => job.phase === "completed")).toHaveLength(30)
      expect(persisted.some((job) => job.id === paused.id && job.stagedAttachments?.length === 1)).toBe(true)
      expect(persisted.some((job) => job.id === uncertain.id)).toBe(true)
    } finally {
      controller.dispose()
    }
  })
  test("persists the completed result and notification before releasing the driver, then closes after hidden grace", async () => {
    const resources = fakePageResources(30_000)
    const f = fixture({ lifecycle: resources.options })
    const owner = "/repo\nses_lifecycle_complete"
    try {
      const job = await f.controller.command({ prompt: "Keep this answer", background: true }, owner)
      await until(() => f.page.generating)
      f.finish("Durable answer")
      resources.add({ pageID: job.pageID!, epoch: 1, lastActivity: Date.now(), protected: false }, f.page)
      await until(() => f.controller.list()[0]?.phase === "completed")
      await until(() => f.disposals() > 0)
      expect(resources.timers.size).toBe(1)
      expect(f.saved()[0]?.phase).toBe("completed")
      expect(f.saved()[0]?.text).toBe("Durable answer")
      expect(f.saved()[0]?.notifications?.some((event) => event.kind === "completed")).toBe(true)
      expect(resources.closed).toHaveLength(0)
      resources.fireNext()
      await until(() => resources.closed.length === 1)
      expect(resources.closed[0]).toMatchObject({ pageID: job.pageID, epoch: 1, reason: "terminal-grace-expired" })
      expect((await f.controller.command({ action: "status", id: job.id }, owner)).text).toBe("Durable answer")
    } finally {
      f.controller.dispose()
      expect(resources.timers.size).toBe(0)
    }
  })
  test("unsafe terminal pages retry with bounded backoff and close after settling without being selected", async () => {
    const resources = fakePageResources()
    const f = fixture({ lifecycle: resources.options })
    try {
      const job = await f.controller.command({ prompt: "Later settled page" }, "/repo\nses_cleanup_retry")
      await until(() => f.page.generating)
      f.finish("Saved result")
      resources.add(
        { pageID: job.pageID!, epoch: 1, lastActivity: Date.now(), protected: false },
        { ...f.page, generating: true },
      )
      await until(() => f.disposals() > 0)
      expect(resources.scheduledDelays).toEqual([30_000])
      for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
        resources.fireNext()
        await until(() => resources.timers.size === 1)
        expect(resources.scheduledDelays.at(-1)).toBe(delay)
        expect(resources.closed).toHaveLength(0)
        expect(resources.focus.some((item) => !item.enabled)).toBe(false)
      }
      resources.states.get(job.pageID!)!.generating = false
      resources.fireNext()
      await until(() => resources.closed.length === 1)
      expect(resources.timers.size).toBe(0)
      expect((await f.controller.command({ action: "read", id: job.id })).text).toBe("Saved result")
    } finally {
      f.controller.dispose()
    }
  })
  test("selected page protection survives overlays and leaving the page starts a fresh grace", async () => {
    const resources = fakePageResources(30_000)
    const f = fixture({ lifecycle: resources.options })
    try {
      const job = await f.controller.command({ prompt: "Viewed result" }, "/repo\nses_lifecycle_view")
      await until(() => f.page.generating)
      f.finish("View answer")
      resources.add({ pageID: job.pageID!, epoch: 1, lastActivity: Date.now(), protected: true }, f.page)
      await until(() => f.controller.list()[0]?.phase === "completed")
      expect(resources.timers.size).toBe(0)
      resources.protect(job.pageID!, false)
      expect(resources.timers.size).toBe(1)
      const staleTimer = [...resources.timers.values()][0]
      resources.protect(job.pageID!, true)
      expect(resources.timers.size).toBe(0)
      staleTimer?.()
      expect(resources.closed).toHaveLength(0)
      resources.protect(job.pageID!, false)
      expect(resources.timers.size).toBe(1)
      expect(resources.closed).toHaveLength(0)
      resources.fireNext()
      await until(() => resources.closed.length === 1)
      expect(resources.focus.some((item) => item.pageID === job.pageID && item.enabled)).toBe(true)
      expect(resources.focus.some((item) => !item.enabled)).toBe(false)
    } finally {
      f.controller.dispose()
      expect(resources.timers.size).toBe(0)
    }
  })
  test("manual close cancels its timer and a stale callback cannot close a replacement epoch", async () => {
    const resources = fakePageResources(30_000)
    const f = fixture({ lifecycle: resources.options })
    try {
      const job = await f.controller.command({ prompt: "Close safely" }, "/repo\nses_lifecycle_close")
      await until(() => f.page.generating)
      f.finish("Closed result")
      resources.add({ pageID: job.pageID!, epoch: 4, lastActivity: Date.now(), protected: false }, f.page)
      await until(() => f.controller.list()[0]?.phase === "completed")
      const staleCallback = [...resources.timers.values()][0]
      expect(resources.timers.size).toBe(1)
      resources.options.resources.close(job.pageID!, 4, "manual-close")
      expect(resources.timers.size).toBe(0)
      resources.add({ pageID: job.pageID!, epoch: 5, lastActivity: Date.now(), protected: true }, f.page)
      staleCallback?.()
      expect(resources.closed).toHaveLength(1)
      expect(resources.pages.get(job.pageID!)?.epoch).toBe(5)
    } finally {
      f.controller.dispose()
      expect(resources.timers.size).toBe(0)
    }
  })
  test("paused and uncertain pages are never terminal cleanup candidates", async () => {
    const resources = fakePageResources(30_000)
    const base = {
      owner: "/repo\nses_lifecycle_recovery",
      requestID: "recovery",
      prompt: "Original prompt",
      url: GPT_PRO_URL,
      createdAt: 1,
      updatedAt: 1,
      submitted: false,
      revision: 0,
    }
    const paused: GptProJob = {
      ...base,
      id: "gpt_lifecycle_paused",
      phase: "paused",
      recovery: { stage: "compose", reason: "resume" },
    }
    const uncertain: GptProJob = {
      ...base,
      id: "gpt_lifecycle_uncertain",
      requestID: "uncertain",
      phase: "send_uncertain",
      submitted: true,
      sendAttempted: true,
    }
    resources.add(
      { pageID: `gpt-pro-page-${paused.id}`, epoch: 1, lastActivity: 1, protected: false },
      { url: GPT_PRO_URL, composer: true, draft: "Original prompt", generating: false, revision: 0, users: [] },
    )
    resources.add(
      { pageID: `gpt-pro-page-${uncertain.id}`, epoch: 1, lastActivity: 2, protected: false },
      { url: GPT_PRO_URL, composer: true, draft: "Original prompt", generating: false, revision: 0, users: [] },
    )
    const f = fixture({ loaded: [paused, uncertain], lifecycle: resources.options, maxResidentPages: 2 })
    try {
      expect(resources.timers.size).toBe(0)
      expect(resources.fireNext()).toBe(false)
      expect(resources.pages.size).toBe(2)
      expect(resources.closed).toHaveLength(0)
    } finally {
      f.controller.dispose()
      expect(resources.timers.size).toBe(0)
    }
  })
  test("read-only cached job access does not allocate a consultation page or driver", async () => {
    const resources = fakePageResources()
    const job: GptProJob = {
      id: "gpt_cached_read_only",
      owner: "/repo\nses_cached_read_only",
      requestID: "cached-read-only",
      phase: "completed",
      prompt: "Saved answer",
      url: GPT_PRO_URL,
      text: "Saved answer body",
      createdAt: 1,
      updatedAt: 1,
      submitted: false,
      revision: 1,
    }
    let driverCreates = 0
    const controller = new GptProController(
      () => {
        driverCreates++
        throw new Error("Read must not acquire a page driver")
      },
      {
        load: () => [job],
        save: () => {},
        config: () => ({ enabled: true, timeoutMinutes: 30 }),
        setConfig: () => {},
      },
      () => {},
      1,
      1,
      resources.options,
    )
    try {
      expect((await controller.command({ action: "read", id: job.id }, job.owner)).text).toBe("Saved answer body")
      expect(driverCreates).toBe(0)
      expect(resources.pages.size).toBe(0)
      expect(resources.timers.size).toBe(0)
    } finally {
      controller.dispose()
      expect(resources.timers.size).toBe(0)
    }
  })
  test("history pruning keeps a terminal result pinned while its page is selected", () => {
    const resources = fakePageResources()
    const jobs: GptProJob[] = Array.from({ length: 31 }, (_, index) => ({
      id: `gpt_pinned_history_${index}`,
      owner: `/repo\nses_pinned_${index}`,
      requestID: `pinned-${index}`,
      phase: "completed",
      prompt: `Prompt ${index}`,
      url: GPT_PRO_URL,
      createdAt: index,
      updatedAt: index,
      submitted: false,
      revision: 0,
    }))
    const pinned = jobs[0]!
    resources.add(
      { pageID: `gpt-pro-page-${pinned.id}`, epoch: 1, lastActivity: 1, protected: true },
      { url: GPT_PRO_URL, composer: true, draft: "", generating: false, revision: 0, users: [] },
    )
    let saved: GptProJob[] = jobs
    const controller = new GptProController(
      {
        open: async () => {},
        ready: async () => ({ url: GPT_PRO_URL, composer: true, draft: "", generating: false, revision: 0, users: [] }),
        page: async () => ({ url: GPT_PRO_URL, composer: true, draft: "", generating: false, revision: 0, users: [] }),
        observeModel: async () => ({
          url: GPT_PRO_URL,
          composer: true,
          draft: "",
          generating: false,
          revision: 0,
          users: [],
        }),
        fill: async () => {},
        submit: async () => {},
        stop: async () => {},
      },
      {
        load: () => saved,
        save: (next) => (saved = next),
        config: () => ({ enabled: true, timeoutMinutes: 30 }),
        setConfig: () => {},
      },
      () => {},
      1,
      1,
      resources.options,
    )
    try {
      expect(controller.list()).toHaveLength(31)
      expect(controller.list().some((job) => job.id === pinned.id)).toBe(true)
      expect(saved).toHaveLength(31)
    } finally {
      controller.dispose()
      expect(resources.timers.size).toBe(0)
    }
  })
  test("manual page close immediately fences active work and preserves explicit recovery state", async () => {
    const resources = fakePageResources()
    const f = fixture({ lifecycle: resources.options })
    try {
      const job = await f.controller.command({ prompt: "Keep this active draft" }, "/repo\nses_manual_page_close")
      await until(() => f.controller.list()[0]?.phase === "generating")
      resources.add({ pageID: job.pageID!, epoch: 1, lastActivity: Date.now(), protected: false }, f.page)
      resources.options.resources.close(job.pageID!, 1, "manual-close")
      await until(() => f.controller.list()[0]?.phase === "paused")
      expect(f.controller.list()[0]?.recovery?.reason).toBe("Consultation page closed")
      expect(f.controller.list()[0]?.resumeCurrentPage).toBe(false)
      expect(resources.timers.size).toBe(0)
      expect(f.disposals()).toBeGreaterThan(0)
      expect(f.counts().submits).toBe(1)
    } finally {
      f.controller.dispose()
    }
  })
  test("stopping a paused job without a cached page does not construct a driver", async () => {
    const resources = fakePageResources()
    const job: GptProJob = {
      id: "gpt_stopped_without_page",
      owner: "/repo\nses_stopped_without_page",
      requestID: "stopped-without-page",
      phase: "paused",
      prompt: "Do not allocate to stop",
      url: GPT_PRO_URL,
      createdAt: 1,
      updatedAt: 1,
      submitted: false,
      recovery: { stage: "open", reason: "Page closed" },
      revision: 0,
    }
    let driverCreates = 0
    const controller = new GptProController(
      () => {
        driverCreates++
        throw new Error("Stop must not allocate a missing page")
      },
      {
        load: () => [job],
        save: () => {},
        config: () => ({ enabled: true, timeoutMinutes: 30 }),
        setConfig: () => {},
      },
      () => {},
      1,
      1,
      resources.options,
    )
    try {
      expect((await controller.command({ action: "stop", id: job.id }, job.owner)).phase).toBe("cancelled")
      expect(driverCreates).toBe(0)
      expect(resources.pages.size).toBe(0)
    } finally {
      controller.dispose()
    }
  })
  test("late tracking snapshots cannot complete a cancelled consultation", async () => {
    const owner = "/repo\nses_cancel_snapshot"
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let blocked = false
    const f = multiPageFixture(1, undefined, async (_jobID, page) => {
      if (!page.generating || blocked) return
      blocked = true
      entered()
      await held
    })
    try {
      const job = await f.controller.command({ requestID: "late-cancel", prompt: "Question" }, owner)
      await until(() => f.pages.get(job.id)?.generating === true)
      await started
      f.finish(job.id, "Late answer")
      await f.controller.command({ action: "stop", id: job.id }, owner)
      expect(f.controller.list().find((candidate) => candidate.id === job.id)?.phase).toBe("cancelled")
      release()
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(f.controller.list().find((candidate) => candidate.id === job.id)?.phase).toBe("cancelled")
      expect(
        f.controller
          .notifications("/repo")
          .some((event) => event.consultationID === job.id && event.kind === "completed"),
      ).toBe(false)
    } finally {
      release()
      f.controller.dispose()
    }
  })
  test("overlapping inspections retain the page mutation fence until every read exits", async () => {
    const f = multiPageFixture(1)
    const owner = "/repo\nses_parallel_reads"
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let firstStarted!: () => void
    let secondStarted!: () => void
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve))
    const firstEntered = new Promise<void>((resolve) => (firstStarted = resolve))
    const secondEntered = new Promise<void>((resolve) => (secondStarted = resolve))
    try {
      const job = await f.controller.command({ requestID: "parallel-reads", prompt: "Question" }, owner)
      await until(() => f.pages.get(job.id)?.generating === true)
      const readA = f.controller.browserCommand(owner, job.id, "state", {}, async () => {
        firstStarted()
        await firstGate
        return { state: {} }
      })
      await firstEntered
      const readB = f.controller.browserCommand(owner, job.id, "state", {}, async () => {
        secondStarted()
        await secondGate
        return { state: {} }
      })
      await secondEntered
      let openFinished = false
      const opening = f.controller.command({ action: "open", id: job.id }, owner).then(() => (openFinished = true))
      releaseFirst()
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(openFinished).toBe(false)
      releaseSecond()
      await Promise.all([readA, readB, opening])
      expect(openFinished).toBe(true)
    } finally {
      releaseFirst()
      releaseSecond()
      f.controller.dispose()
    }
  })
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
  test("explicitly resumes a confirmed paused turn by reopening its original URL when its page is gone", async () => {
    const url = `${GPT_PRO_URL}c/original`
    const job: GptProJob = {
      id: "gpt_cold_confirmed",
      owner: "/repo\nses_cold_confirmed",
      requestID: "cold-confirmed",
      phase: "paused",
      prompt: "Original question",
      url,
      createdAt: 1,
      updatedAt: 1,
      submitted: true,
      userID: "original-user",
      userCount: 1,
      recovery: { stage: "track", reason: "Page closed while paused" },
      revision: 0,
    }
    let pageAvailable = false
    const f = fixture({
      loaded: [job],
      hasPage: () => pageAvailable,
      open: async () => {
        pageAvailable = true
      },
      initialPage: {
        url,
        model: "Website selection",
        targetModel: false,
        composer: true,
        draft: "",
        generating: false,
        revision: 0,
        users: [{ id: "original-user", text: job.prompt }],
        answers: [],
      },
    })
    try {
      f.finish("Original answer")
      await f.controller.command({ action: "resume", id: job.id }, job.owner)
      await until(() => f.controller.list()[0]?.phase === "completed")
      expect(f.opens).toEqual([{ url, fresh: false }])
      expect(f.controller.list()[0]?.userID).toBe("original-user")
      expect(f.counts()).toEqual({ submits: 0, stops: 0, fills: 0 })
      expect(f.logs.join("\n")).toContain("explicit resume reopening missing page")
    } finally {
      f.controller.dispose()
    }
  })
  test("explicitly resumes a genuinely unsent paused job on a missing page with one original send", async () => {
    const job: GptProJob = {
      id: "gpt_cold_unsent",
      owner: "/repo\nses_cold_unsent",
      requestID: "cold-unsent",
      phase: "paused",
      prompt: "Send this original question",
      url: GPT_PRO_URL,
      createdAt: 1,
      updatedAt: 1,
      submitted: false,
      recovery: { stage: "compose", reason: "Page closed before send" },
      revision: 0,
    }
    let pageAvailable = false
    const f = fixture({
      loaded: [job],
      hasPage: () => pageAvailable,
      open: async () => {
        pageAvailable = true
      },
    })
    try {
      await f.controller.command({ action: "resume", id: job.id }, job.owner)
      await until(() => f.counts().submits === 1)
      expect(f.opens).toEqual([{ url: GPT_PRO_URL, fresh: true }])
      expect(f.page.users).toHaveLength(1)
      expect(f.page.users[0]?.text).toBe(job.prompt)
      expect(f.counts()).toEqual({ submits: 1, stops: 0, fills: 1 })
      await f.controller.command({ action: "stop", id: job.id }, job.owner)
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
  test("retains the observed submitted label when the next composer remounts", async () => {
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
      expect(f.controller.list()[0].errorCode).toBe("verification")
      expect(f.counts().fills).toBe(0)
      expect(f.counts().submits).toBe(0)
    } finally {
      f.controller.dispose()
    }
  })
  test("login failure receives its own code and human handoff without filling or sending", async () => {
    const f = fixture({
      verify: async () => {
        throw new GptProPageError("Sign in to ChatGPT", "login")
      },
    })
    try {
      await f.controller.command({ prompt: "Wait for login" }, "/repo\nses_needs_login")
      await until(() => f.controller.list()[0]?.errorCode === "login")
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
          attachments: [
            {
              id: "pdf1",
              name: "invalid.pdf",
              path: invalidPdf,
              mime: "application/pdf",
              size: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
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
        attachments: [
          {
            id: "review-file",
            name: "review.md",
            path: original,
            mime: "text/markdown",
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      })
      await until(() => f.counts().submits === 1)
      expect(f.counts().fills).toBe(1)
      expect(f.page.users[0].attachments).toEqual([
        {
          name: job.attachments?.[0].uploadName,
          status: "ready",
        },
      ])
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
        attachments: [
          {
            id: "partial-file",
            name: "partial.md",
            path: original,
            mime: "text/markdown",
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
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
  test("preserves per-file ready and failed status from fresh upload evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-partial-status-"))
    try {
      const first = path.join(root, "first.md")
      const second = path.join(root, "second.md")
      const firstBytes = Buffer.from("# first\n")
      const secondBytes = Buffer.from("# second\n")
      await Promise.all([writeFile(first, firstBytes), writeFile(second, secondBytes)])
      const f = fixture({
        stagingRoot: path.join(root, "owned"),
        upload: async (files, _mayDispatch, _shouldContinue, setAttachments) => {
          setAttachments([
            { name: files[0]!.name, status: "ready" },
            { name: files[1]!.name, status: "failed" },
          ])
          throw new Error("Upload snapshot could not be reconciled")
        },
      })
      const job = await f.controller.command({
        requestID: "per-file-upload-status",
        prompt: "Review both files",
        attachments: [
          {
            id: "first-file",
            name: "first.md",
            path: first,
            mime: "text/markdown",
            size: firstBytes.byteLength,
            sha256: createHash("sha256").update(firstBytes).digest("hex"),
          },
          {
            id: "second-file",
            name: "second.md",
            path: second,
            mime: "text/markdown",
            size: secondBytes.byteLength,
            sha256: createHash("sha256").update(secondBytes).digest("hex"),
          },
        ],
      })
      await until(() => f.saved()[0]?.phase === "paused")
      expect(f.saved()[0].attachments?.map((attachment) => attachment.status)).toEqual(["ready", "failed"])
      expect(f.counts().fills).toBe(0)
      expect(f.counts().submits).toBe(0)
      await f.controller.command({ action: "stop", id: job.id })
      f.controller.dispose()
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
        attachments: [
          {
            id: "cancel-file",
            name: "cancel.md",
            path: original,
            mime: "text/markdown",
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
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
  test("cancellation during active-input re-resolution prevents the upload boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-input-cancel-"))
    let started!: () => void
    const resolverStarted = new Promise<void>((resolve) => (started = resolve))
    let release!: () => void
    const resolverGate = new Promise<void>((resolve) => (release = resolve))
    let uploads = 0
    try {
      const original = path.join(root, "cancel-before-dispatch.md")
      const bytes = Buffer.from("# cancel before file input\n")
      await writeFile(original, bytes)
      const f = fixture({
        stagingRoot: path.join(root, "owned"),
        uploadDispatchGate: async () => {
          started()
          await resolverGate
        },
        upload: async () => {
          uploads++
        },
      })
      const job = await f.controller.command({
        requestID: "cancel-input-resolution",
        prompt: "Review this file",
        attachments: [
          {
            id: "cancel-file",
            name: "cancel-before-dispatch.md",
            path: original,
            mime: "text/markdown",
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      })
      await resolverStarted
      await f.controller.command({ action: "stop", id: job.id })
      release()
      await until(() => f.saved()[0]?.phase === "cancelled")
      expect(uploads).toBe(0)
      expect(f.saved()[0].uploadAttempted).toBe(false)
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
        attachments: [
          {
            id: "expected-file",
            name: "expected.md",
            path: original,
            mime: "text/markdown",
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      })
      await until(() => f.saved()[0]?.phase === "send_uncertain")
      expect(f.counts().submits).toBe(1)
      expect(f.saved()[0].userID).toBeUndefined()
      expect(f.saved()[0].phase).not.toBe("completed")
      expect(f.saved()[0].error).toContain("different attachments")
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
          setAttachments(
            files.map(({ name, mime, sha256 }) => ({
              name,
              kind: mime?.startsWith("image/") ? "image" : "document",
              sha256,
              status: "ready",
            })),
          )
        },
      })
      const job = await f.controller.command({
        requestID: "image-digest-waits",
        prompt: "Review this chart",
        attachments: [
          {
            id: "chart-image",
            name: "chart.png",
            path: original,
            mime: "image/png",
            size: bytes.byteLength,
            sha256,
          },
        ],
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
  test("binds a transformed website preview separately from the source-image digest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-preview-bind-"))
    try {
      const original = path.join(root, "chart.png")
      const sourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      const previewBytes = Buffer.from("resized website thumbnail")
      const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex")
      const previewSha256 = createHash("sha256").update(previewBytes).digest("hex")
      await writeFile(original, sourceBytes)
      const f = fixture({
        stagingRoot: path.join(root, "owned"),
        upload: async (files, _mayDispatch, _shouldContinue, setAttachments) => {
          setAttachments(files.map(({ name }) => ({ name, kind: "image", sha256: previewSha256, status: "ready" })))
        },
      })
      const job = await f.controller.command(
        {
          requestID: "preview-bind",
          prompt: "Review the chart",
          attachments: [
            {
              id: "chart-image",
              name: "chart.png",
              path: original,
              mime: "image/png",
              size: sourceBytes.byteLength,
              sha256: sourceSha256,
              previewSha256: "a".repeat(64),
            } as GptProAttachment,
          ],
        },
        "main",
      )
      await until(() => f.controller.list()[0]?.phase === "generating")
      const stored = f.controller.list()[0].attachments?.[0]
      expect(stored?.sha256).toBe(sourceSha256)
      expect(stored?.previewSha256).toBe(previewSha256)
      expect(stored?.previewSha256).not.toBe(stored?.sha256)
      f.finish("Chart received")
      await until(() => f.controller.list()[0]?.phase === "completed")
      expect((await f.controller.command({ action: "read", id: job.id }, "main")).text).toBe("Chart received")
      expect(f.counts().submits).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("rejects a changed preview at the send boundary without dispatching", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-preview-change-"))
    try {
      const original = path.join(root, "chart.png")
      const sourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      const previewSha256 = createHash("sha256").update("bound preview").digest("hex")
      const changedSha256 = createHash("sha256").update("replacement preview").digest("hex")
      await writeFile(original, sourceBytes)
      let f: ReturnType<typeof fixture>
      f = fixture({
        stagingRoot: path.join(root, "owned"),
        upload: async (files, _mayDispatch, _shouldContinue, setAttachments) => {
          setAttachments(files.map(({ name }) => ({ name, kind: "image", sha256: previewSha256, status: "ready" })))
        },
        submitGate: async () => {
          f.page.attachments![0]!.sha256 = changedSha256
        },
      })
      const job = await f.controller.command({
        requestID: "preview-change",
        prompt: "Review the chart",
        attachments: [
          {
            id: "chart-image",
            name: "chart.png",
            path: original,
            mime: "image/png",
            size: sourceBytes.byteLength,
            sha256: createHash("sha256").update(sourceBytes).digest("hex"),
          },
        ],
      })
      await until(() => f.saved()[0]?.phase === "paused")
      expect(f.saved()[0].attachments?.[0].previewSha256).toBe(previewSha256)
      expect(f.saved()[0].sendAttempted).toBeUndefined()
      expect(f.counts().submits).toBe(0)
      await f.controller.command({ action: "stop", id: job.id })
      f.controller.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("rejects a changed sent-image preview instead of returning its answer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-sent-preview-change-"))
    try {
      const original = path.join(root, "chart.png")
      const sourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      const previewSha256 = createHash("sha256").update("bound preview").digest("hex")
      const changedSha256 = createHash("sha256").update("replacement image").digest("hex")
      await writeFile(original, sourceBytes)
      const f = fixture({
        stagingRoot: path.join(root, "owned"),
        upload: async (files, _mayDispatch, _shouldContinue, setAttachments) => {
          setAttachments(files.map(({ name }) => ({ name, kind: "image", sha256: previewSha256, status: "ready" })))
        },
      })
      const job = await f.controller.command({
        requestID: "sent-preview-change",
        prompt: "Review the chart",
        attachments: [
          {
            id: "chart-image",
            name: "chart.png",
            path: original,
            mime: "image/png",
            size: sourceBytes.byteLength,
            sha256: createHash("sha256").update(sourceBytes).digest("hex"),
          },
        ],
      })
      await until(() => f.controller.list()[0]?.phase === "generating")
      f.page.users[0]!.attachments = [{ name: "", kind: "image", sha256: changedSha256, status: "ready" }]
      f.finish("Wrong image answer")
      await until(() => f.controller.list()[0]?.phase === "paused")
      expect(f.controller.list()[0].text).toBeUndefined()
      expect(f.counts().submits).toBe(1)
      await f.controller.command({ action: "stop", id: job.id })
      f.controller.dispose()
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
  test("pause before the send boundary resumes the authorized draft without refilling", async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatchReady = new Promise<void>((resolve) => {
      entered = resolve
    })
    const f = fixture({
      submitGate: async () => {
        entered()
        await gate
      },
    })
    const owner = "/repo\nses_pause_before_send"
    try {
      const job = await f.controller.command({ prompt: "Authorized original prompt" }, owner)
      await dispatchReady
      expect(f.page.draft).toBe("Authorized original prompt")
      expect(f.counts().fills).toBe(1)
      expect(f.counts().submits).toBe(0)
      await f.controller.command({ action: "pause", id: job.id }, owner)
      expect(f.controller.list()[0].phase).toBe("paused")
      await f.controller.command({ action: "resume", id: job.id }, owner)
      release()
      await until(() => f.page.generating)
      expect(f.counts().fills).toBe(1)
      expect(f.counts().submits).toBe(1)
      expect(f.page.users[0]?.text).toBe("Authorized original prompt")
      f.finish("Answer")
      await until(() => f.controller.list()[0].phase === "completed")
    } finally {
      release()
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
  test("a manual follow-up does not supply an unrelated answer to the owned turn", async () => {
    const f = fixture()
    try {
      const job = await f.controller.command({ prompt: "Original" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      f.page.users.push({ id: "manual", text: "Another question" })
      f.finish("Unrelated")
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(f.controller.list()[0].phase).toBe("generating")
      expect((await f.controller.command({ action: "read", id: job.id }, "main")).text).toBeUndefined()
    } finally {
      f.controller.dispose()
    }
  })
  test("continues read-only tracking of an unfinished owned turn while a later turn generates", async () => {
    const f = fixture()
    try {
      const job = await f.controller.command({ prompt: "Original" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      const owned = f.page.users[0]!
      f.page.users.push({ id: "manual-followup", text: "Follow-up" })
      f.page.generating = true
      f.page.answer = {
        id: "answer-followup",
        userID: "manual-followup",
        text: "Partial later response",
        html: "<p>Partial later response</p>",
        complete: false,
        truncated: false,
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(f.controller.list()[0].phase).toBe("generating")
      expect(f.controller.list()[0].text).toBeUndefined()
      f.page.answers = [
        {
          id: "answer-owned",
          userID: owned.id,
          text: "Owned final",
          html: "<p>Owned final</p>",
          complete: true,
          truncated: false,
          generating: false,
          completionEvidence: "settled-marker",
        },
        {
          id: "answer-followup",
          userID: "manual-followup",
          text: "Partial later response",
          html: "<p>Partial later response</p>",
          complete: false,
          truncated: false,
          generating: true,
          completionEvidence: "unknown",
        },
      ]
      await until(() => f.controller.list()[0].phase === "completed")
      const result = await f.controller.command({ action: "read", id: job.id }, "main")
      expect(result.userID).toBe(owned.id)
      expect(result.text).toBe("Owned final")
      expect(f.counts().submits).toBe(1)
    } finally {
      f.controller.dispose()
    }
  })
  test("complete adapter evidence does not require a separate completion-reason label", async () => {
    const f = fixture()
    try {
      const job = await f.controller.command({ prompt: "Evidence contract" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      const user = f.page.users[0]!
      f.page.answers = [
        {
          id: "answer-owned",
          userID: user.id,
          text: "Static but incomplete",
          html: "<p>Static but incomplete</p>",
          complete: false,
          truncated: false,
          generating: false,
          completionEvidence: "unknown",
        },
      ]
      f.page.answer = {
        id: "answer-owned",
        userID: user.id,
        text: "Static but incomplete",
        html: "<p>Static but incomplete</p>",
        complete: false,
        truncated: false,
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(f.controller.list()[0].phase).toBe("generating")
      expect((await f.controller.command({ action: "read", id: job.id }, "main")).text).toBe("Static but incomplete")

      f.page.answers = [
        {
          id: "answer-owned",
          userID: user.id,
          text: "Complete reply",
          html: "<p>Complete reply</p>",
          complete: true,
          truncated: false,
          generating: false,
          completionEvidence: undefined as unknown as "unknown",
        },
      ]
      f.page.answer = {
        id: "answer-owned",
        userID: user.id,
        text: "Complete reply",
        html: "<p>Complete reply</p>",
        complete: true,
        truncated: false,
      }
      await until(() => f.controller.list()[0].phase === "completed")
      expect((await f.controller.command({ action: "read", id: job.id }, "main")).text).toBe("Complete reply")
    } finally {
      f.controller.dispose()
    }
  })
  test("completes the owned answer despite a later user turn, draft, and global generation", async () => {
    const f = fixture()
    try {
      const job = await f.controller.command({ prompt: "Original" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      const owned = f.page.users[0]!
      f.page.answers = [
        {
          id: "answer-owned",
          userID: owned.id,
          text: "Owned answer",
          html: "<p>Owned answer</p>",
          complete: true,
          truncated: false,
          generating: false,
          completionEvidence: "settled-marker",
        },
      ]
      f.page.answer = {
        id: "answer-later",
        userID: "manual-followup",
        text: "Partial unrelated answer",
        html: "<p>Partial unrelated answer</p>",
        complete: false,
        truncated: false,
      }
      f.page.users.push({ id: "manual-followup", text: "Follow-up" })
      f.page.draft = "A separate draft"
      f.page.generating = true
      await until(() => f.controller.list()[0].phase === "completed")
      const result = await f.controller.command({ action: "read", id: job.id }, "main")
      expect(result.userID).toBe(owned.id)
      expect(result.text).toBe("Owned answer")
      expect(result.html).toBe("<p>Owned answer</p>")
      expect(f.counts().submits).toBe(1)
    } finally {
      f.controller.dispose()
    }
  })
  test("ignores a later turn's request error but blocks an owned-turn error", async () => {
    const f = fixture()
    try {
      const job = await f.controller.command({ prompt: "Original" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      const owned = f.page.users[0]!
      f.page.answers = [
        {
          id: "answer-owned",
          userID: owned.id,
          text: "Owned answer",
          html: "<p>Owned answer</p>",
          complete: true,
          truncated: false,
          generating: false,
          completionEvidence: "response-actions",
        },
      ]
      f.page.users.push({ id: "manual-followup", text: "Follow-up" })
      f.page.error = { kind: "request", message: "Unrelated request failed", scope: "turn", userID: "manual-followup" }
      await until(() => f.controller.list()[0].phase === "completed")
      expect((await f.controller.command({ action: "read", id: job.id }, "main")).text).toBe("Owned answer")
      f.controller.dispose()

      const target = fixture()
      const targetJob = await target.controller.command({ prompt: "Target error" }, "main")
      await until(() => target.controller.list()[0].phase === "generating")
      const targetUser = target.page.users[0]!
      target.page.error = {
        kind: "request",
        message: "Owned turn request failed",
        scope: "turn",
        userID: targetUser.id,
      }
      await until(() => target.controller.list()[0].phase === "paused")
      expect(target.controller.list()[0].error).toContain("Owned turn request failed")
      expect(target.controller.list()[0].userID).toBe(targetUser.id)
      await target.controller.command({ action: "stop", id: targetJob.id }, "main")
      target.controller.dispose()
    } finally {
      f.controller.dispose()
    }
  })
  test("ignores a stale prior-turn request error when starting a new consultation", async () => {
    const f = fixture({
      initialPage: {
        url: GPT_PRO_URL,
        model: "GPT-6 Pro",
        targetModel: true,
        composer: true,
        draft: "",
        generating: false,
        revision: 0,
        users: [{ id: "previous-user", text: "Previous request" }],
        error: {
          kind: "request",
          message: "Previous request failed",
          scope: "turn",
          userID: "previous-user",
        },
      },
    })
    try {
      const job = await f.controller.command({ prompt: "New managed question" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      f.finish("New answer")
      await until(() => f.controller.list()[0].phase === "completed")
      expect(f.counts().submits).toBe(1)
      expect((await f.controller.command({ action: "read", id: job.id }, "main")).text).toBe("New answer")
    } finally {
      f.controller.dispose()
    }
  })
  test("a page-wide verification challenge still blocks owned-turn completion", async () => {
    const f = fixture()
    try {
      await f.controller.command({ prompt: "Owned turn" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      f.page.error = {
        kind: "verification",
        message: "Human verification is required",
        scope: "page",
      }
      await until(() => f.controller.list()[0].phase === "paused")
      expect(f.controller.list()[0].userID).toBe("user-1")
      const job = f.controller.list()[0]
      expect((await f.controller.command({ action: "read", id: job.id }, "main")).text).toBeUndefined()
      expect(f.controller.list()[0].recovery?.needsHuman).toBe(true)
    } finally {
      f.controller.dispose()
    }
  })
  test.each(["Pro", "Thinking effort", "", "GPT-5.5 Pro"])(
    "model observation %j cannot block submission or tracking",
    async (model) => {
      const f = fixture({
        verify: async () => {
          f.page.model = model
          f.page.targetModel = false
          return structuredClone(f.page)
        },
      })
      try {
        const job = await f.controller.command({ prompt: "Original" }, "main")
        await until(() => f.controller.list()[0].phase === "generating")
        f.page.model = ""
        f.finish("Owned reply")
        await until(() => f.controller.list()[0].phase === "completed")
        expect((await f.controller.command({ action: "read", id: job.id }, "main")).text).toBe("Owned reply")
        expect(f.controller.list()[0].model).toBe(model)
        expect(f.controller.list()[0].recovery).toBeUndefined()
        expect(f.counts().submits).toBe(1)
      } finally {
        f.controller.dispose()
      }
    },
  )
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
      expect(calls).toEqual([job.pageID])
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
  test("managed recovery sends with unknown model semantics and still rejects a second send", async () => {
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
      const job = await f.controller.command(
        {
          prompt: "Original prompt",
          attachments: [
            {
              id: "managed-file",
              name: "managed.md",
              path: original,
              mime: "text/markdown",
              size: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
        },
        owner,
      )
      await until(() => !!f.controller.list()[0].recovery)
      f.page.draft = "Original prompt"
      f.page.model = ""
      f.page.targetModel = false
      await expect(f.controller.command({ action: "send", id: job.id, uid: "dismiss" }, owner)).rejects.toThrow(
        "not a send control",
      )
      await f.controller.command({ action: "send", id: job.id, uid: "send" }, owner)
      await expect(f.controller.command({ action: "send", id: job.id, uid: "send" }, owner)).rejects.toThrow(
        "already attempted",
      )
      expect(f.controller.list()[0].phase).toBe("paused")
      expect(f.controller.list()[0].userID).toBeDefined()
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
    expect(next.controller.config().maxConcurrent).toBe(4)
    expect(next.controller.config().maxResidentPages).toBe(8)
    expect(next.controller.setConfig({ enabled: true, timeoutMinutes: 30, maxConcurrent: 99 }).maxConcurrent).toBe(8)
    expect(next.controller.setConfig({ enabled: true, timeoutMinutes: 30, maxConcurrent: 0 }).maxConcurrent).toBe(1)
    expect(
      next.controller.setConfig({ enabled: true, timeoutMinutes: 30, maxConcurrent: 5, maxResidentPages: 2 })
        .maxResidentPages,
    ).toBe(5)
    expect(
      next.controller.setConfig({ enabled: true, timeoutMinutes: 30, maxConcurrent: 2, maxResidentPages: 99 })
        .maxResidentPages,
    ).toBe(32)
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
      stagedAttachments: [
        { id: file.id, path: `/owned/${file.uploadName}`, sha256: file.sha256, uploadName: file.uploadName },
      ],
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
        users: [
          {
            id: "user-existing",
            text: "Original attachment prompt",
            attachments: [{ name: file.uploadName, kind: "document", status: "ready" }],
          },
        ],
      },
      upload: async () => {
        uploads++
      },
    })
    await until(() => f.controller.list()[0].phase === "generating")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(uploads).toBe(0)
    expect(f.counts().submits).toBe(0)
    f.controller.dispose()
  })
  test("keeps a submitted turn uncertain when attachment proof is incomplete", async () => {
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
      stagedAttachments: [
        {
          id: attachment.id,
          path: `/owned/${attachment.uploadName}`,
          sha256: attachment.sha256,
          uploadName: attachment.uploadName,
        },
      ],
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
        users: [
          {
            id: "rendered-user",
            text: job.prompt,
            attachments: [{ name: "", kind: "image", status: "unknown" }],
          },
        ],
      },
    })
    await until(() => f.controller.list()[0]?.phase === "send_uncertain")
    expect(f.saved()[0]?.url).toBe(GPT_PRO_URL)
    expect(f.saved()[0].userID).toBeUndefined()
    expect(f.saved()[0].sendAttempted).toBe(true)
    expect(f.counts().submits).toBe(0)
    await expect(
      f.controller.browserCommand("/repo\nses_url_recovery", job.id, "navigate", { url: GPT_PRO_URL }, async () => {
        throw new Error("uncertain page mutation must not dispatch")
      }),
    ).rejects.toThrow("recovery handoff")
    f.controller.dispose()
  })
  test("retries the same unsent job after the active-composer input becomes available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-input-retry-"))
    const stagingRoot = path.join(root, "attachments")
    const jobID = "gpt_00000000-0000-0000-0000-000000000003"
    const uploadName = `${jobID.slice(4)}-1-chart.md`
    const stagedPath = path.join(stagingRoot, jobID, "chart-file", uploadName)
    const bytes = Buffer.from("# chart\n")
    await mkdir(path.dirname(stagedPath), { recursive: true })
    await writeFile(stagedPath, bytes)
    const attachment = {
      id: "chart-file",
      name: "chart.md",
      uploadName,
      mime: "text/markdown",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      status: "unknown" as const,
    }
    const job: GptProJob = {
      id: jobID,
      owner: "owner",
      requestID: "input-later",
      phase: "paused",
      recovery: { stage: "compose", reason: "ChatGPT's verified attachment input is unavailable" },
      error: "ChatGPT's verified attachment input is unavailable",
      prompt: "Review this chart",
      attachments: [attachment],
      stagedAttachments: [{ id: attachment.id, path: stagedPath, sha256: attachment.sha256, uploadName }],
      url: GPT_PRO_URL,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      submitted: false,
      uploadAttempted: false,
      revision: 0,
    }
    let uploads = 0
    const f = fixture({
      loaded: [job],
      stagingRoot,
      upload: async (files, mayDispatch, _shouldContinue, setAttachments) => {
        expect(mayDispatch).toBe(true)
        uploads++
        setAttachments(files.map(({ name }) => ({ name, status: "ready" })))
      },
    })
    try {
      await until(() => f.controller.list()[0]?.phase === "paused")
      await f.controller.command({ action: "resume", id: job.id }, "owner")
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (f.counts().submits !== 1) throw new Error(f.logs.join("\n"))
      await until(() => f.counts().submits === 1)
      expect(uploads).toBe(1)
      expect(f.saved()[0].uploadAttempted).toBe(true)
      expect(f.saved()[0].sendAttempted).toBe(true)
      f.finish("Read the chart")
      await until(() => f.saved()[0].phase === "completed")
      expect(f.counts().submits).toBe(1)
    } finally {
      f.controller.dispose()
      await rm(root, { recursive: true, force: true })
    }
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
          attachments: [
            {
              id: "file1",
              name: "original.txt",
              uploadName: `retention-${index}-original.txt`,
              path: source,
              mime: "text/plain",
              size: 12,
              sha256: "a".repeat(64),
              status: "ready",
            },
          ],
          stagedAttachments: [
            { id: "file1", path: staged, sha256: "a".repeat(64), uploadName: `retention-${index}-original.txt` },
          ],
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
  test("previews the exact owned attachment copy without changing or exposing job paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-preview-"))
    try {
      const stored = await previewJob(root)
      const f = fixture({ loaded: [stored.job], stagingRoot: stored.stagingRoot })
      expect(stored.job.stagedAttachments?.[0]?.path).toBe(
        path.join(stored.stagingRoot, stored.job.id, stored.attachmentID, stored.job.attachments![0]!.uploadName),
      )
      const before = JSON.stringify(f.controller.list())
      const outside = path.join(root, "outside.txt")
      await writeFile(outside, "not the staged attachment")
      const preview = await f.controller.attachmentPreview({
        id: stored.job.id,
        attachmentID: stored.attachmentID,
        path: outside,
      } as { id: string; attachmentID: string })
      expect(preview).toEqual({
        name: "preview.txt",
        mime: "text/plain",
        base64: stored.bytes.toString("base64"),
      })
      expect(JSON.stringify(f.controller.list())).toBe(before)
      expect(JSON.stringify(f.controller.list())).not.toContain(stored.source)
      expect(JSON.stringify(f.controller.list())).not.toContain(stored.stagedPath)
      expect(f.logs.join("\n")).not.toContain(stored.bytes.toString("utf8"))
      f.controller.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("previews preparing and failed jobs without changing their state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-preview-state-"))
    let release!: () => void
    const blockedOpen = new Promise<void>((resolve) => (release = resolve))
    const f = fixture({ stagingRoot: path.join(root, "owned"), open: () => blockedOpen })
    try {
      const source = path.join(root, "source.txt")
      const bytes = Buffer.from("prepared attachment")
      await writeFile(source, bytes)
      const job = await f.controller.command(
        {
          prompt: "Review this attachment",
          attachments: [
            {
              id: "prepared-file",
              name: "prepared.txt",
              path: source,
              mime: "text/plain",
              size: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
        },
        "owner",
      )
      await until(() => f.saved()[0]?.phase === "preparing")
      const phase = f.saved()[0].phase
      const preview = await f.controller.attachmentPreview({
        id: job.id,
        attachmentID: "prepared-file",
      })
      expect(preview.base64).toBe(bytes.toString("base64"))
      expect(f.saved()[0].phase).toBe(phase)
      await f.controller.command({ action: "stop", id: job.id }, "owner")
      release()
      await until(() => f.saved()[0]?.phase === "cancelled")
      f.controller.dispose()

      const failed = await previewJob(root, {
        id: "gpt_00000000-0000-0000-0000-000000000098",
        phase: "failed",
      })
      const failedController = fixture({ loaded: [failed.job], stagingRoot: failed.stagingRoot })
      const before = JSON.stringify(failedController.controller.list())
      expect(
        (
          await failedController.controller.attachmentPreview({
            id: failed.job.id,
            attachmentID: failed.attachmentID,
          })
        ).base64,
      ).toBe(failed.bytes.toString("base64"))
      expect(JSON.stringify(failedController.controller.list())).toBe(before)
      failedController.controller.dispose()
    } finally {
      release?.()
      f.controller.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  test("rejects unknown jobs, cross-job IDs, traversal, missing copies, and changed hashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-preview-reject-"))
    try {
      const first = await previewJob(root, { id: "gpt_00000000-0000-0000-0000-000000000097" })
      const second = await previewJob(root, {
        id: "gpt_00000000-0000-0000-0000-000000000096",
        attachmentID: "other-preview",
      })
      const f = fixture({ loaded: [first.job, second.job], stagingRoot: first.stagingRoot })
      const before = JSON.stringify(f.controller.list())
      await expect(
        f.controller.attachmentPreview({
          id: "gpt_00000000-0000-0000-0000-000000000095",
          attachmentID: first.attachmentID,
        }),
      ).rejects.toThrow("not available")
      await expect(
        f.controller.attachmentPreview({ id: first.job.id, attachmentID: second.attachmentID }),
      ).rejects.toThrow("not available")
      await expect(
        f.controller.attachmentPreview({ id: first.job.id, attachmentID: "../preview-file" }),
      ).rejects.toThrow("not available")
      expect(JSON.stringify(f.controller.list())).toBe(before)
      f.controller.dispose()

      await writeFile(first.stagedPath, Buffer.from("tampered payload for gpt_00000000-0000-0000-0000-000000000097"))
      const tampered = fixture({ loaded: [first.job], stagingRoot: first.stagingRoot })
      await expect(
        tampered.controller.attachmentPreview({ id: first.job.id, attachmentID: first.attachmentID }),
      ).rejects.toThrow("unavailable or changed")
      expect(tampered.controller.list()[0].phase).toBe("completed")
      tampered.controller.dispose()

      await rm(second.stagedPath, { force: true })
      const missing = fixture({ loaded: [second.job], stagingRoot: second.stagingRoot })
      await expect(
        missing.controller.attachmentPreview({ id: second.job.id, attachmentID: second.attachmentID }),
      ).rejects.toThrow("unavailable or changed")
      expect(missing.controller.list()[0].phase).toBe("completed")
      missing.controller.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
