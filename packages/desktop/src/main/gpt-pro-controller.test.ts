import { describe, expect, test } from "bun:test"
import { GptProController, type GptProDriverAPI } from "./gpt-pro-controller"
import { GPT_PRO_URL, type GptProConfig, type GptProJob, type GptProPageState } from "@opencode-ai/util/gpt-pro"
import { GptProPageError } from "./gpt-pro-page-error"

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
    generating: false,
    revision: 0,
    users: [],
  }
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
    submit: async () => {
      submits++
      page.users.push({ id: `user-${submits}`, text: page.draft })
      page.draft = ""
      page.generating = true
      page.url = `${GPT_PRO_URL}c/test`
      page.answer = undefined
    },
    stop: async () => {
      stops++
      await options.stop?.()
      page.generating = false
    },
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
  test("a website rejection fails once and releases the browser instead of waiting forever", async () => {
    const f = fixture()
    try {
      const job = await f.controller.command({ prompt: "Question", requestID: "rejected" }, "main")
      await until(() => f.controller.list()[0].phase === "generating")
      f.page.error = { kind: "request", message: "ChatGPT rejected request (HTTP 403)" }
      await until(() => f.controller.list()[0].phase === "failed")
      await until(() => !f.controller.busy())
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
        throw new GptProPageError("Browser verification required")
      },
    })
    try {
      await f.controller.command({ prompt: "Question" }, "main")
      await until(() => f.controller.list()[0].phase === "failed")
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
  test("a wrong model fails without dispatching a prompt", async () => {
    const f = fixture({
      verify: async () => {
        throw new Error("Wrong model")
      },
    })
    try {
      await f.controller.command({ prompt: "Original" }, "main")
      await until(() => f.controller.list()[0].phase === "failed")
      expect(f.counts().submits).toBe(0)
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
})
