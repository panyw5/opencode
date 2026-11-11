import { expect, test } from "bun:test"
import { downloadExtensionArchive } from "./extension-download"

const url = "https://github.com/example/extension/releases/download/v1/package.tgz"

test("allows bounded HTTPS CDN redirects and omits ambient credentials", async () => {
  const calls: string[] = []
  const bytes = await downloadExtensionArchive(url, async (input, init) => {
    calls.push(input)
    expect(init.redirect).toBe("manual")
    expect(init.credentials).toBe("omit")
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/package.tgz" },
        })
      : new Response(new Uint8Array([1, 2, 3]))
  })
  expect([...bytes]).toEqual([1, 2, 3])
  expect(calls).toHaveLength(2)
})

test("rejects HTTP downgrade before making the redirected request, including multi-hop", async () => {
  for (const secureHops of [0, 1]) {
    const calls: string[] = []
    await expect(
      downloadExtensionArchive(url, async (input) => {
        calls.push(input)
        return new Response(null, {
          status: 302,
          headers: {
            location: calls.length <= secureHops ? "https://cdn.example/package.tgz" : "http://cdn.example/package.tgz",
          },
        })
      }),
    ).rejects.toThrow(/HTTPS/)
    expect(calls).toHaveLength(secureHops + 1)
    expect(calls.every((input) => input.startsWith("https:"))).toBe(true)
  }
})

test("rejects credentials, excessive redirects and excessive response size", async () => {
  await expect(
    downloadExtensionArchive("https://user:secret@example.com/a.tgz", async () => {
      throw Error("must not fetch")
    }),
  ).rejects.toThrow(/HTTPS/)
  let calls = 0
  await expect(
    downloadExtensionArchive(url, async () => {
      calls++
      return new Response(null, { status: 302, headers: { location: url } })
    }),
  ).rejects.toThrow(/redirect limit/)
  expect(calls).toBe(4)
  await expect(
    downloadExtensionArchive(
      url,
      async () => new Response("x", { headers: { "content-length": String(101 * 1024 * 1024) } }),
    ),
  ).rejects.toThrow(/100 MiB/)
})
