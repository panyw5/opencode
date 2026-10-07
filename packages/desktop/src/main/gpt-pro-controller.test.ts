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
    submit: async (beforeDispatch) => {
      await beforeDispatch?.()
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
    element: async (uid) => ({ composer: uid === "composer", send: uid === "send" }),
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
    const f = fixture({
      verify: async () => {
        throw Error("Model picker overlay")
      },
    })
    try {
      const owner = "/repo\nses_parent"
      const job = await f.controller.command({ prompt: "Original prompt" }, owner)
      await until(() => !!f.controller.list()[0].recovery)
      f.page.draft = "Original prompt"
      await expect(f.controller.command({ action: "send", id: job.id, uid: "dismiss" }, owner)).rejects.toThrow(
        "not a send control",
      )
      await f.controller.command({ action: "send", id: job.id, uid: "send" }, owner)
      await expect(f.controller.command({ action: "send", id: job.id, uid: "send" }, owner)).rejects.toThrow(
        "already attempted",
      )
      await expect(
        f.controller.browserCommand(owner, job.id, "type", { uid: "composer", text: "Replacement" }, async () => ({})),
      ).rejects.toThrow("only the original")
      await f.controller.command({ action: "resume", id: job.id }, owner)
      f.finish("Original reply")
      await until(() => f.controller.list()[0].phase === "completed")
      expect(f.counts().submits).toBe(1)
      expect(f.counts().fills).toBe(0)
    } finally {
      f.controller.dispose()
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
})
