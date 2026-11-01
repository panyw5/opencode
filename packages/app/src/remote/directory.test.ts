import { describe, expect, test } from "bun:test"
import { createRemoteDirectoryPlatform } from "./directory"

describe("remote directory platform", () => {
  test("lists host directories and encodes paths without caching", async () => {
    const platform = createRemoteDirectoryPlatform(async (input, init) => {
      const url = new URL(String(input), "https://remote.example")
      expect(url.pathname).toBe("/remote/api/directory")
      expect(url.searchParams.get("path")).toBe("~/Projects/a & b/")
      expect(url.searchParams.get("mode")).toBe("list")
      expect(init?.cache).toBe("no-store")
      return Response.json({
        path: "/home/test/Projects/a & b",
        entries: [{ path: "/home/test/Projects/a & b/repo", kind: "directory" }],
      })
    })
    expect(await platform.listLocalDirectory("~/Projects/a & b/")).toEqual([
      { path: "/home/test/Projects/a & b/repo", kind: "directory" },
    ])
  })

  test("validates selections and returns canonical host paths, excluding missing folders", async () => {
    const platform = createRemoteDirectoryPlatform(async (input) => {
      const url = new URL(String(input), "https://remote.example")
      expect(url.searchParams.get("mode")).toBe("validate")
      return url.searchParams.get("path") === "~/missing"
        ? new Response(null, { status: 404 })
        : Response.json({ path: "/home/test/repo", entries: [] })
    })
    expect(await platform.filterDirectories(["~/repo", "~/missing"])).toEqual(["/home/test/repo"])
  })

  test("does not hide authentication or filesystem request failures as empty directories", async () => {
    for (const status of [401, 403, 404, 500]) {
      const platform = createRemoteDirectoryPlatform(async () => new Response(null, { status }))
      await expect(platform.listLocalDirectory("~/")).rejects.toThrow(`Directory request failed (${status})`)
      if (status !== 404) await expect(platform.filterDirectories(["~/"])).rejects.toThrow()
    }
  })
})
