import { expect, test } from "bun:test"
import type { SessionMessagePage } from "@/context/global-sync/session-messages"
import {
  shareMessages,
  visibleShareMessages,
  toggleShareSelection,
  runShareExport,
  localShareMarkdown,
  selectVisibleShareMessages,
} from "./session-share-model"
import { shareBody, shareHTML } from "./session-share-html"

test("orders mixed ID generations, excludes summaries, and respects revert boundary", () => {
  const session = [
    { id: "msg_ffold", role: "user", time: { created: 1 } },
    { id: "msg_00new", role: "assistant", time: { created: 2 } },
    { id: "msg_01summary", role: "assistant", time: { created: 3 }, summary: true },
    { id: "msg_02revert", role: "user", time: { created: 4 } },
  ]
  const data = {
    session,
    part: session.map(({ id }) => ({ id, part: [{ type: "text", text: id }] })),
    complete: true,
  } as SessionMessagePage
  const messages = shareMessages([data], "msg_02revert")
  expect(messages.map((item) => item.id)).toEqual(["msg_ffold", "msg_00new"])
  expect(messages[0].time?.created).toBe(1)
})

test("exports slash invocation instead of expanded template, and safe attachment names", () => {
  const data = {
    session: [{ id: "1", role: "user" }],
    part: [
      {
        id: "1",
        part: [
          { type: "text", text: "hidden expanded template /private/path" },
          { type: "text", text: "/review main", synthetic: true, metadata: { kind: "command-invocation" } },
          { type: "file", mime: "application/pdf", filename: "/private/report.pdf", url: "file:///private/report.pdf" },
          { type: "file", mime: "image/png", filename: "photo.png", url: "https://private.example/photo.png" },
        ],
      },
    ],
    complete: true,
  } as SessionMessagePage
  expect(shareMessages([data])[0].markdown).toBe("/review main\n\n[report.pdf]\n\n[photo.png]")
  data.part[0].part = [
    { type: "subtask", command: "review" },
    { type: "text", text: "template" },
  ] as SessionMessagePage["part"][number]["part"]
  expect(shareMessages([data])[0].markdown).toBe("/review")
})

test("filter does not mutate selection and toggles are unique", () => {
  const messages = [
    { id: "1", role: "user" as const, markdown: "one" },
    { id: "2", role: "assistant" as const, markdown: "two" },
  ]
  const selected = ["1", "2"]
  expect(visibleShareMessages(messages, "assistant").map((item) => item.id)).toEqual(["2"])
  expect(selected).toEqual(["1", "2"])
  expect(toggleShareSelection(selected, "1", true)).toEqual(selected)
  expect(toggleShareSelection(selected, "1", false)).toEqual(["2"])
})

test("empty export never saves; cancellation, failure and retry preserve selection", async () => {
  let calls = 0
  expect(
    (
      await runShareExport([], async () => {
        calls++
        return { cancelled: false, files: 1 }
      })
    ).status,
  ).toBe("empty")
  expect(calls).toBe(0)
  const selected = ["1"]
  expect((await runShareExport(selected, async () => ({ cancelled: true, files: 0 }))).status).toBe("cancelled")
  expect(
    (
      await runShareExport(selected, async () => {
        throw new Error("save failed")
      })
    ).status,
  ).toBe("failed")
  expect((await runShareExport(selected, async () => ({ cancelled: false, files: 2 }))).status).toBe("saved")
  expect(selected).toEqual(["1"])
})

test("HTML preserves long code without collapse or remote resources", async () => {
  const preview = document.createElement("div")
  const code = "line\n".repeat(5000)
  preview.innerHTML = `<div data-code-collapse="true" style="height:50px"><pre style="max-height:50px"><code>${code}</code></pre><button>Expand</button></div><img src="https://private.example/x" alt="Remote image"><img src="data:image/png;base64,AAAA">`
  const body = shareBody(preview)
  expect(body).toContain(code)
  expect(body).not.toContain("data-code-collapse")
  expect(body).not.toContain("https://private")
  expect(body).not.toContain("50px")
  expect(body).toContain("data:image/png;base64,AAAA")
  const html = await shareHTML(preview, "light")
    expect(html).toContain("export-style-")
  expect(html).not.toContain("<button")
})

test("remote markdown images are replaced without changing literal code", () => {
  const code = "`![example](https://example.test/x)`"
  expect(localShareMarkdown(`![photo](https://example.test/x)\n${code}`)).toBe(`[photo]\n${code}`)
})

test("select all only adds filtered messages and retains hidden selections", () => {
  const messages = [
    { id: "u1", role: "user" as const, markdown: "one" },
    { id: "a1", role: "assistant" as const, markdown: "two" },
    { id: "u2", role: "user" as const, markdown: "three" },
  ]
  expect(selectVisibleShareMessages([], messages, "assistant")).toEqual(["a1"])
  expect(selectVisibleShareMessages(["u1"], messages, "assistant")).toEqual(["u1", "a1"])
  expect(selectVisibleShareMessages(["a1"], messages, "assistant")).toEqual(["a1"])
  expect(selectVisibleShareMessages([], messages, "all")).toEqual(["u1", "a1", "u2"])
})

test("export snapshots resolved KaTeX styles and embeds same-origin font data", async () => {
  const previousURL = window.location.href
  window.location.href = "http://localhost/"
  const style = document.createElement("style")
  style.textContent =
    "@media all{@font-face{font-family:KaTeX_Main;src:url(/math.woff2)}.katex{font-family:KaTeX_Main}.app-secret{color:red}}"
  document.head.append(style)
  const preview = document.createElement("div")
  preview.innerHTML = '<span class="katex"><span style="height:1em">x</span></span>'
  document.body.append(preview)
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input))
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "font/woff2" } })
  }) as typeof fetch
  try {
    const html = await shareHTML(preview, "light")
    expect(requests.length).toBe(1)
    expect(html).toContain("data:font/woff2;base64,AQID")
    expect(html).toContain("height:16px")
    expect(html).toContain('class="katex export-style-')
    expect(html).not.toContain("app-secret")
    expect(html).not.toContain("/math.woff2")
  } finally {
    window.location.href = previousURL
    globalThis.fetch = original
    style.remove()
    preview.remove()
  }
})
