import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "bun:test"

import { PromptHistoryStore } from "./prompt-history"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "opencode-prompt-history-"))
  roots.push(root)
  return { root, store: new PromptHistoryStore(root, false) }
}

const image = (id: string, data = "aGVsbG8=") => ({
  type: "image",
  id,
  filename: "proof.png",
  mime: "image/png",
  dataUrl: `data:image/png;base64,${data}`,
})

const entry = (text: string, images: ReturnType<typeof image>[] = []) =>
  JSON.stringify({
    prompt: [{ type: "text", content: text, start: 0, end: text.length }, ...images],
    comments: [],
  })

describe("PromptHistoryStore", () => {
  test("stores image bytes outside entry JSON and hydrates them on page load", async () => {
    const { root, store } = await setup()
    await store.append("normal", entry("hello", [image("first")]))

    const files = await readdir(join(root, "entries"))
    expect(files).toHaveLength(1)
    const raw = await readFile(join(root, "entries", files[0]!), "utf8")
    expect(raw).not.toContain("aGVsbG8=")
    expect(raw).toContain("historyImage")

    const page = await store.page("normal", 0, 20)
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toContain("data:image/png;base64,aGVsbG8=")
  })

  test("deduplicates identical image content and consecutive prompts despite transient image ids", async () => {
    const { root, store } = await setup()
    expect((await store.append("normal", entry("same", [image("first")]))).added).toBe(true)
    expect((await store.append("normal", entry("same", [image("second")]))).added).toBe(false)
    expect(await readdir(join(root, "images"))).toHaveLength(1)
    expect((await store.inspect()).normal).toBe(1)
  })

  test("loads fixed-size pages instead of returning the complete history", async () => {
    const { store } = await setup()
    for (let index = 0; index < 25; index += 1) await store.append("normal", entry(`prompt-${index}`))

    const first = await store.page("normal", 0, 20)
    expect(first.entries).toHaveLength(20)
    expect(first.nextOffset).toBe(20)
    expect(first.hasMore).toBe(true)

    const second = await store.page("normal", first.nextOffset, 20)
    expect(second.entries).toHaveLength(5)
    expect(second.hasMore).toBe(false)
  })
})
