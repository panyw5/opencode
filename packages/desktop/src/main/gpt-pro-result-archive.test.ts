import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createGptProResultArchive } from "./gpt-pro-result-archive"
import { GptProController } from "./gpt-pro-controller"
import { DEFAULT_GPT_PRO_CONFIG, type GptProJob } from "@opencode-ai/util/gpt-pro"

const job = (extra: Partial<GptProJob> = {}): GptProJob => ({
  id: "gpt_saved",
  owner: "/repo\nsession",
  requestID: "request",
  phase: "completed",
  prompt: "Question",
  url: "https://chatgpt.com/c/saved",
  createdAt: 1,
  updatedAt: 2,
  submitted: true,
  revision: 1,
  text: "Answer",
  html: '<p>Answer <math><annotation encoding="application/x-tex">x^2</annotation></math></p>',
  ...extra,
})

describe("shared GPT-Pro result archive", () => {
  test("survives independent connections, local history pruning, and process restarts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gpt-pro-archive-"))
    const file = path.join(dir, "results.db")
    const first = createGptProResultArchive(new Database(file), [], () => {})
    const second = createGptProResultArchive(new Database(file), [], () => {})
    try {
      first.save([job({ accountID: "secret", pageID: "live-page", notifications: [] })])
      first.save([])
      expect(second.read("gpt_saved", ["/repo\nsession"])).toMatchObject({ text: "Answer", html: job().html })
      expect(second.read("gpt_saved", ["/other\nsession"])).toBeUndefined()
      expect(second.read("gpt_saved")?.accountID).toBeUndefined()
      expect(second.read("gpt_saved")?.pageID).toBeUndefined()
      first.save([job({ updatedAt: 1, text: "stale" })])
      expect(second.read("gpt_saved")?.text).toBe("Answer")
    } finally {
      first.close()
      second.close()
    }
    const reopened = createGptProResultArchive(new Database(file), [], () => {})
    try {
      expect(reopened.read("gpt_saved")?.html).toBe(job().html)
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("imports terminal legacy answers but never active jobs, and resolves successors safely", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gpt-pro-legacy-"))
    const file = path.join(dir, "legacy")
    writeFileSync(
      file,
      JSON.stringify({
        jobs: [
          job({ successorID: "gpt_next" }),
          job({ id: "gpt_next", text: "Next" }),
          job({ id: "gpt_active", phase: "generating" }),
        ],
      }),
    )
    const archive = createGptProResultArchive(new Database(":memory:"), [file], () => {})
    try {
      expect(archive.read("gpt_saved")?.text).toBe("Next")
      expect(archive.read("gpt_active")).toBeUndefined()
      archive.save([job({ id: "gpt_next", owner: "/other", updatedAt: 100, text: "Wrong owner" })])
      expect(archive.read("gpt_saved")?.text).toBe("Next")
    } finally {
      archive.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("controller serves archived read/status without importing execution or mutation authority", async () => {
    const archive = createGptProResultArchive(new Database(":memory:"), [], () => {})
    archive.save([job()])
    const opened: string[] = []
    const controller = new GptProController(
      () => {
        throw new Error("must not start browser")
      },
      {
        load: () => [],
        save: () => {},
        config: () => DEFAULT_GPT_PRO_CONFIG,
        setConfig: () => {},
        readResult: archive.read,
        openResult: async (job) => {
          opened.push(job.id)
        },
      },
      () => {},
    )
    try {
      expect((await controller.command({ action: "read", id: "gpt_saved" }, "/repo\nsession")).html).toBe(job().html)
      const status = await controller.command({ action: "status", id: "gpt_saved" }, "/repo\nsession")
      expect(status.phase).toBe("completed")
      expect(status.html).toBeUndefined()
      expect(controller.list()).toEqual([])
      await controller.command({ action: "open", id: "gpt_saved" }, "/repo\nsession")
      expect(opened).toEqual(["gpt_saved"])
      await expect(
        controller.command({ action: "open", id: "gpt_saved" }, "/other", ["/repo\nsession"]),
      ).rejects.toThrow("not found")
      await expect(controller.command({ action: "read", id: "gpt_saved" }, "/other")).rejects.toThrow("not found")
      await expect(controller.command({ action: "send", id: "gpt_saved" }, "/repo\nsession")).rejects.toThrow(
        "not found",
      )
    } finally {
      controller.dispose()
      archive.close()
    }
  })
})
