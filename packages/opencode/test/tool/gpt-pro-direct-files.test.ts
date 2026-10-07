import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { materializeGptProDirectFiles } from "../../src/tool/gpt-pro-direct-files"
import { tmpdir } from "../fixture/fixture"

describe("gpt-pro-direct-files", () => {
  test("preserves pasted filenames in private per-file staging dirs and cleans them up", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "local.md")
    await writeFile(source, "local source")
    const part = {
      type: "file",
      filename: "research notes.txt",
      mime: "text/plain",
      url: `data:text/plain;base64,${Buffer.from("pasted content").toString("base64")}`,
    }

    const staged = await Effect.runPromise(
      materializeGptProDirectFiles(
        [
          { type: "text", text: "Review" },
          { type: "file", source: { type: "file", path: source }, url: "data:text/plain;base64,bG9jYWw=" },
          part,
        ],
        tmp.path,
      ),
    )
    expect(staged.files[0]).toBe(source)
    expect(path.basename(staged.files[1]!)).toBe("research notes.txt")
    expect(await readFile(staged.files[1]!, "utf8")).toBe("pasted content")
    expect((await stat(path.dirname(staged.files[1]!))).mode & 0o777).toBe(0o700)
    expect((await stat(staged.files[1]!)).mode & 0o777).toBe(0o600)
    await Effect.runPromise(staged.cleanup())
    expect(await Bun.file(staged.files[1]!).exists()).toBe(false)
  })

  test("rejects remote and malformed pasted data without leaving staged files", async () => {
    await using tmp = await tmpdir()
    for (const url of ["https://example.invalid/private.png", "data:image/png;base64,%%%="]) {
      const exit = await Effect.runPromiseExit(materializeGptProDirectFiles([{ type: "file", url }], tmp.path))
      expect(Exit.isFailure(exit)).toBe(true)
    }
    expect(await Bun.file(path.join(tmp.path, ".opencode")).exists()).toBe(false)
  })

  test("rejects oversized pasted data before creating a staging directory", async () => {
    await using tmp = await tmpdir()
    const encoded = Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64")
    const exit = await Effect.runPromiseExit(
      materializeGptProDirectFiles(
        [{ type: "file", filename: "large.png", url: `data:image/png;base64,${encoded}` }],
        tmp.path,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Bun.file(path.join(tmp.path, ".opencode")).exists()).toBe(false)
  })

  test("refuses an external .opencode symlink without writing pasted data through it", async () => {
    await using tmp = await tmpdir()
    const outside = await mkdtemp(path.join(os.tmpdir(), "gpt-pro-outside-"))
    const stagingRoot = path.join(tmp.path, ".opencode")
    try {
      await symlink(outside, stagingRoot)
      const exit = await Effect.runPromiseExit(
        materializeGptProDirectFiles(
          [
            {
              type: "file",
              filename: "notes.txt",
              url: `data:text/plain;base64,${Buffer.from("private").toString("base64")}`,
            },
          ],
          tmp.path,
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("interruption leaves no staged pasted attachment", async () => {
    await using tmp = await tmpdir()
    const encoded = Buffer.alloc(20 * 1024 * 1024).toString("base64")
    const fiber = Effect.runFork(
      materializeGptProDirectFiles(
        [{ type: "file", filename: "large.png", url: `data:image/png;base64,${encoded}` }],
        tmp.path,
      ),
    )
    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    if (Exit.isSuccess(exit)) await Effect.runPromise(exit.value.cleanup())
    const stagingRoot = path.join(tmp.path, ".opencode")
    if (await Bun.file(stagingRoot).exists()) {
      expect((await readdir(stagingRoot)).filter((entry) => entry.startsWith("gpt-pro-"))).toEqual([])
    }
  })
})
