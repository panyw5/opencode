import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { symlink, truncate, writeFile } from "fs/promises"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-opencode-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("visible-file event stream starts without retaining the full runtime", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")
    const response = await request(FilePaths.watch, tmp.path, { path: "hello.txt" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()
    try {
      const first = await reader.read()
      const text = new TextDecoder().decode(first.value)
      expect(text).toContain("file.watcher.updated")
      expect(text).toContain("hello.txt")
    } finally {
      await reader.cancel()
    }
  })

  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toContainEqual({ path: "hello.txt", added: 1, removed: 0, status: "added" })
  })

  test("serves exact raw text and binary bytes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "spaced.txt"), "  hello\n")
    await Bun.write(path.join(tmp.path, "payload.bin"), new Uint8Array([0, 1, 2, 255]))

    const [text, binary] = await Promise.all([
      request(FilePaths.raw, tmp.path, { path: "spaced.txt" }),
      request(FilePaths.raw, tmp.path, { path: "payload.bin" }),
    ])

    expect(text.status).toBe(200)
    expect(await text.text()).toBe("  hello\n")
    expect(text.headers.get("cache-control")).toBe("private, no-store")
    expect(text.headers.get("x-content-type-options")).toBe("nosniff")

    expect(binary.status).toBe(200)
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]))
  })

  test("forces HTML raw responses to download-safe MIME", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "unsafe.html"), "<script>window.bad = true</script>")

    const response = await request(FilePaths.raw, tmp.path, { path: "unsafe.html" })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/octet-stream")
  })

  test("rejects missing, absolute, traversal, directory, and symlink paths", async () => {
    await using tmp = await tmpdir({ git: true })
    await using outside = await tmpdir()
    await Bun.write(path.join(outside.path, "secret.txt"), "secret")
    await symlink(path.join(outside.path, "secret.txt"), path.join(tmp.path, "escape.txt"))

    const responses = await Promise.all([
      request(FilePaths.raw, tmp.path, { path: "missing.txt" }),
      request(FilePaths.raw, tmp.path, { path: path.join(tmp.path, "missing.txt") }),
      request(FilePaths.raw, tmp.path, { path: "../secret.txt" }),
      request(FilePaths.raw, tmp.path, { path: "." }),
      request(FilePaths.raw, tmp.path, { path: "escape.txt" }),
    ])

    expect(responses.map((response) => response.status)).toEqual([404, 403, 403, 404, 404])
  })

  test("rejects raw files over 50 MB before reading", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "large.bin")
    await writeFile(file, "")
    await truncate(file, 50 * 1024 * 1024 + 1)

    const response = await request(FilePaths.raw, tmp.path, { path: "large.bin" })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      _tag: "PayloadTooLargeError",
      maxBytes: 50 * 1024 * 1024,
    })
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, files, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.status).toBe(200)
    expect(await files.json()).toContain("hello.txt")

    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])
  })
})
