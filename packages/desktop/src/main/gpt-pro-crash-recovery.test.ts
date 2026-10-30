import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createGptProBodyJournal } from "./gpt-pro-body-journal"
import { createGptProExecutionStore } from "./gpt-pro-execution-store"
import { GptProController } from "./gpt-pro-controller"
import { syntheticVault } from "../../scripts/gpt-pro-crash-fixture"

test.each(["intent", "vault", "body"])(
  "restart after forced process exit at %s never replays a question",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "gpt-crash-recovery-"))
    const child = Bun.spawn(
      [process.execPath, new URL("../../scripts/gpt-pro-crash-fixture.ts", import.meta.url).pathname, mode, root],
      { stdout: "ignore", stderr: "pipe" },
    )
    expect(await child.exited).toBe(mode === "intent" ? 71 : mode === "vault" ? 72 : 73)
    const bodies = createGptProBodyJournal(join(root, "bodies"), () => {})
    const execution = createGptProExecutionStore(new Database(join(root, "execution.db")), () => {}, 60_000, bodies)
    let drivers = 0
    const controller = new GptProController(
      () => {
        drivers++
        throw Error("Crash recovery must not allocate a sending driver")
      },
      {
        load: () =>
          execution.load(() => {
            throw Error("Legacy migration replayed")
          }),
        save: (jobs) => execution.save(jobs),
        config: () => ({ enabled: true, timeoutMinutes: 1 }),
        setConfig: () => {},
        flush: async () => {
          await execution.flush()
        },
      },
      () => {},
    )
    try {
      const job = controller.list()[0]
      expect(drivers).toBe(0)
      expect(job.phase).toBe(mode === "intent" ? "send_uncertain" : mode === "vault" ? "paused" : "interrupted")
      expect(job.accountID).toBe("original-account-hash")
      expect(controller.notifications().some((event) => event.kind === "completed")).toBe(false)
      if (mode === "intent")
        await expect(controller.command({ action: "resume", id: job.id }, job.owner)).rejects.toThrow("uncertain")
      if (mode === "vault")
        expect((await syntheticVault(root).read())?.[0].value).toBe("SYNTHETIC_VERIFIED_SAME_ACCOUNT")
      if (mode === "body")
        expect((await controller.command({ action: "read", id: job.id }, job.owner)).text).toBe("new checkpointed body")
    } finally {
      controller.dispose()
      await execution.close()
      await bodies.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
