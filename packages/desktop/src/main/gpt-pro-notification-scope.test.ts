import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_GPT_PRO_CONFIG, type GptProJob } from "@opencode-ai/util/gpt-pro"
import { GptProController } from "./gpt-pro-controller"

const DIR = mkdtempSync(join(tmpdir(), "gpt-pro-scope-"))
process.on("exit", () => rmSync(DIR, { recursive: true, force: true }))

function job(overrides: Partial<GptProJob> = {}): GptProJob {
  return {
    id: "gpt_completed",
    owner: `${DIR}\nparent`,
    requestID: "request",
    phase: "completed",
    prompt: "test",
    url: "https://chatgpt.com/c/test",
    createdAt: 1,
    updatedAt: 1,
    submitted: true,
    revision: 1,
    background: true,
    text: "result",
    ...overrides,
  }
}
function fixture(jobs: GptProJob[]) {
  let saves = 0
  const controller = new GptProController(
    () => {
      throw Error("history must not open a driver")
    },
    {
      load: () => jobs,
      save: () => {
        saves++
      },
      config: () => ({ ...DEFAULT_GPT_PRO_CONFIG, enabled: false }),
      setConfig: () => {},
    },
    () => {},
  )
  const internal = controller as unknown as {
    jobs: GptProJob[]
    notify(job: GptProJob): void
    update(job: GptProJob, update: Partial<GptProJob>): void
  }
  return { controller, internal, saves: () => saves }
}

test("completed history is never checked again during periodic notification polls", () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => job({ id: `gpt_${i}`, notificationPhase: "completed" })))
  const notify = spyOn(f.internal, "notify")
  try {
    const saves = f.saves()
    for (let i = 0; i < 30; i++) expect(f.controller.notifications()).toEqual([])
    expect(notify).not.toHaveBeenCalled()
    expect(f.saves()).toBe(saves)
    // Existing retention keeps only the latest 30 acknowledged terminal records.
    expect(f.controller.list()).toHaveLength(30)
  } finally {
    notify.mockRestore()
    f.controller.dispose()
  }
})

test("unannounced completion is recovered once and redelivered only until acknowledged", () => {
  const f = fixture([job()])
  const notify = spyOn(f.internal, "notify")
  try {
    const events = f.controller.notifications(DIR)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("completed")
    expect(events[0].text).toBe("result")
    expect(f.controller.notifications(DIR)).toEqual(events)
    expect(notify).not.toHaveBeenCalled()
    f.controller.acknowledge("/other", [events[0].id])
    expect(f.controller.notifications(DIR)).toEqual(events)
    f.controller.acknowledge(DIR, [events[0].id])
    const saves = f.saves()
    for (let i = 0; i < 20; i++) expect(f.controller.notifications()).toEqual([])
    f.controller.acknowledge(DIR, [events[0].id])
    expect(f.saves()).toBe(saves)
  } finally {
    notify.mockRestore()
    f.controller.dispose()
  }
})

test("undeliverable notifications are evicted instead of redelivering forever", () => {
  const f = fixture([
    // Owner session prefix exists but the directory is gone at startup.
    job({ id: "gpt_gone_dir", owner: "/definitely/missing/gpt-pro-dir\nses_1" }),
    // No session owner at all: nothing can ever route this event.
    job({ id: "gpt_no_owner", owner: "anonymous" }),
    // Live directory, but the event outlived the wake-up window.
    job({ id: "gpt_stale", owner: `${DIR}\nses_2` }),
    // Control: live directory, fresh event — must survive.
    job({ id: "gpt_fresh", owner: `${DIR}\nses_3` }),
  ])
  const internal = f.controller as unknown as {
    jobs: GptProJob[]
    pruneUndeliverableNotifications(now: number, checkOwnerDirectory: boolean): void
  }
  try {
    const byID = new Map(internal.jobs.map((j) => [j.id, j]))
    expect(byID.get("gpt_gone_dir")?.notifications ?? []).toEqual([])
    expect(byID.get("gpt_no_owner")?.notifications ?? []).toEqual([])
    expect(byID.get("gpt_fresh")?.notifications ?? []).toHaveLength(1)

    const stale = byID.get("gpt_stale")!
    const fresh = byID.get("gpt_fresh")!
    stale.notifications = [
      { ...stale.notifications![0], at: Date.now() - 8 * 24 * 60 * 60 * 1000 },
      { ...stale.notifications![0], id: "gpt_stale:notification:2", at: Date.now() },
    ]
    fresh.notifications = [{ ...fresh.notifications![0], at: Date.now() - 8 * 24 * 60 * 60 * 1000 }]
    internal.pruneUndeliverableNotifications(Date.now(), false)
    // Runtime pruning drops expired and unroutable events but never fs-checks
    // directories: a temporarily unmounted path must not lose its wake-up.
    expect(stale.notifications).toHaveLength(1)
    expect(fresh.notifications ?? []).toEqual([])
    internal.pruneUndeliverableNotifications(Date.now(), true)
    expect(stale.notifications).toHaveLength(1)
  } finally {
    f.controller.dispose()
  }
})

test("generation enters progress polling and completion immediately leaves it", () => {
  const f = fixture([job({ notificationPhase: "completed" })])
  try {
    const current = f.internal.jobs[0]
    f.internal.update(current, {
      phase: "generating",
      text: "updated",
      notificationAt: Date.now(),
      notificationText: "result",
    })
    const notify = spyOn(f.internal, "notify")
    try {
      expect(f.controller.notifications()).toEqual([])
      expect(notify).toHaveBeenCalledTimes(1)
      current.notificationAt = 0
      expect(f.controller.notifications()[0].kind).toBe("progress")
      f.internal.update(current, { phase: "completed", text: "final" })
      notify.mockClear()
      const events = f.controller.notifications()
      expect(events.some((event) => event.kind === "completed" && event.text === "final")).toBe(true)
      expect(notify).not.toHaveBeenCalled()
    } finally {
      notify.mockRestore()
    }
  } finally {
    f.controller.dispose()
  }
})
