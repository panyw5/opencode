import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveSha256, extensionArchiveDigest } from "./archive-digest"

describe("extension archive digest", () => {
  test("computes the same digest as sha256sum semantics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ext-archive-"))
    const file = join(dir, "demo.tgz")
    const bytes = Buffer.from("fake archive bytes")
    await writeFile(file, bytes)
    const digest = await extensionArchiveDigest(file)
    expect(digest.sha256).toBe(archiveSha256(bytes))
    expect(digest.size).toBe(bytes.byteLength)
    expect(digest.path).toBe(file)
  })

  test("rejects non-tgz paths and directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ext-archive-"))
    await expect(extensionArchiveDigest(join(dir, "demo.zip"))).rejects.toThrow(/\.tgz/)
    await expect(extensionArchiveDigest(dir)).rejects.toThrow()
  })

  test("rejects missing files", async () => {
    await expect(extensionArchiveDigest("/nonexistent/path/demo.tgz")).rejects.toThrow()
  })
})
