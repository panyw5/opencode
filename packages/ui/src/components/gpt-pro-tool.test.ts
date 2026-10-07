import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { attachmentViews } from "./gpt-pro-tool"

describe("GPT-Pro attachment display", () => {
  test("keeps only display-safe fields and recognizes per-file states", () => {
    expect(
      attachmentViews([
        { id: "a", name: "report.pdf", path: "/Users/alice/private/report.pdf", status: "uploading", sha256: "secret" },
        { id: "b", name: "C:\\work\\draft.txt", path: "C:\\work\\draft.txt", status: "failed", error: "Upload failed" },
        { id: "c", name: "unknown.bin", status: "future-state" },
        { id: "d", name: "waiting.txt", status: "pending" },
        { id: "e", name: "ready.txt", status: "ready" },
      ]),
    ).toEqual([
      { id: "a", name: "report.pdf", status: "uploading", error: undefined },
      { id: "b", name: "draft.txt", status: "failed", error: "Upload failed" },
      { id: "c", name: "unknown.bin", status: "unknown", error: undefined },
      { id: "d", name: "waiting.txt", status: "pending", error: undefined },
      { id: "e", name: "ready.txt", status: "ready", error: undefined },
    ])
  })

  test("removes local paths from failure details", () => {
    const [attachment] = attachmentViews([
      {
        id: "a",
        name: "private.txt",
        path: "/Users/alice/private.txt",
        status: "failed",
        error: "Could not read /Users/alice/private.txt: permission denied",
      },
    ])

    expect(attachment.error).toBe("Could not read : permission denied")
    expect(JSON.stringify(attachment)).not.toContain("/Users/alice")
  })

  test("renders actual attachment rows and statuses through the Solid UI transform", async () => {
    const server = await createServer({
      configFile: false,
      plugins: [solid({ solid: { generate: "ssr" } })],
      resolve: { alias: { "@": fileURLToPath(new URL("../../../app/src", import.meta.url)) } },
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    })
    try {
      const component = await server.ssrLoadModule(fileURLToPath(new URL("./gpt-pro-tool.tsx", import.meta.url)))
      const { renderToString } = await server.ssrLoadModule("solid-js/web")
      const html = renderToString(() =>
        component.GptProTool({
          status: "running",
          input: {},
          metadata: {
            attachments: [
              { id: "a", name: "report.pdf", path: "/private/report.pdf", status: "pending", sha256: "secret" },
              { id: "b", name: "chart.png", path: "/private/chart.png", status: "uploading", sha256: "secret" },
              { id: "c", name: "notes.txt", path: "/private/notes.txt", status: "ready", sha256: "secret" },
              { id: "d", name: "broken.md", path: "/private/broken.md", status: "failed", error: "Permission denied" },
              { id: "e", name: "future.dat", path: "/private/future.dat", status: "unrecognized", sha256: "secret" },
            ],
          },
        }),
      )

      for (const name of ["report.pdf", "chart.png", "notes.txt", "broken.md", "future.dat"])
        expect(html).toContain(name)
      for (const status of ["pending", "uploading", "ready", "failed", "unknown"])
        expect(html).toContain(`data-attachment-status="${status}"`)
      expect(html).toContain("Permission denied")
      expect(html).not.toContain("/private/")
      expect(html).not.toContain("secret")
    } finally {
      await server.close()
    }
  })
})
