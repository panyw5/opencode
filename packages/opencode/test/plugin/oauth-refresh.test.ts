import { expect, test } from "bun:test"
import { refreshOAuth } from "../../src/plugin/oauth-refresh"
import { tmpdir } from "../fixture/fixture"
import path from "node:path"

test("concurrent refresh waiters share failure, and a later call can retry", async () => {
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const error = new Error("token endpoint unavailable")
  const operation = async () => {
    calls++
    entered()
    await gate
    throw error
  }
  const first = refreshOAuth("test", "failure", "shared", operation).catch((error) => error)
  await ready
  const second = refreshOAuth("test", "failure", "shared", operation).catch((error) => error)
  release()
  expect(await first).toBe(error)
  expect(await second).toBe(error)
  expect(calls).toBe(1)
  expect(await refreshOAuth("test", "failure", "shared", async () => "recovered")).toBe("recovered")
})

test("refresh file lock coordinates independent processes and rechecks stored credentials", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "credential.json")
  await Bun.write(file, JSON.stringify({ access: "old" }))
  let requests = 0
  using server = Bun.serve({
    port: 0,
    fetch() {
      requests++
      return Response.json({ access: "fresh" })
    },
  })
  const start = () =>
    Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "../fixture/oauth-refresh-process.ts"),
        server.url.toString(),
        file,
      ],
      {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
  const children = [start(), start()]
  try {
    const results = await Promise.all(
      children.map(async (child) => {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(code, stderr).toBe(0)
        return stdout.trim()
      }),
    )
    expect(results).toEqual(["fresh", "fresh"])
    expect(requests).toBe(1)
  } finally {
    for (const child of children) child.kill()
  }
})
