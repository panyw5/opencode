import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import {
  attachmentViews,
  fallbackAttachmentViews,
  fetchGptProAttachmentPreview,
  gptProPreviewJobID,
  isValidGptProAttachmentPreview,
} from "./gpt-pro-tool"

describe("GPT-Pro attachment display", () => {
  test("binds previews to the current child job before the original tool job", () => {
    expect(gptProPreviewJobID("intervention-child", "original-consultation")).toBe("intervention-child")
    expect(gptProPreviewJobID(undefined, "original-consultation")).toBe("original-consultation")
  })

  test("scopes tool styles to the rendered root and Portal previews independently", async () => {
    const css = await Bun.file(new URL("./gpt-pro-tool.css", import.meta.url)).text()
    expect(css).toContain('[data-component="gpt-pro-tool"]')
    expect(css).toContain(".gpt-pro-attachment-preview {")
    expect(css).not.toContain(".gpt-pro-tool .gpt-pro-attachment-preview")
  })

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
      { id: "a", attachmentID: "a", name: "report.pdf", mime: undefined, status: "uploading", error: undefined },
      { id: "b", attachmentID: "b", name: "draft.txt", mime: undefined, status: "failed", error: "Upload failed" },
      { id: "c", attachmentID: "c", name: "unknown.bin", mime: undefined, status: "unknown", error: undefined },
      { id: "d", attachmentID: "d", name: "waiting.txt", mime: undefined, status: "pending", error: undefined },
      { id: "e", attachmentID: "e", name: "ready.txt", mime: undefined, status: "ready", error: undefined },
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

  test("shows basename-only pre-job files as non-previewable and marks pre-job errors failed", () => {
    const attachments = fallbackAttachmentViews([
      "/Users/alice/private/report.pdf",
      "C:\\secret\\notes.md",
      "file:///Users/alice/My%20draft%20%25.md?start=3",
    ])
    expect(attachments.map(({ name, status, attachmentID }) => ({ name, status, attachmentID }))).toEqual([
      { name: "report.pdf", status: "unknown", attachmentID: undefined },
      { name: "notes.md", status: "unknown", attachmentID: undefined },
      { name: "My draft %.md", status: "unknown", attachmentID: undefined },
    ])
    expect(JSON.stringify(attachments)).not.toContain("private")
    expect(JSON.stringify(attachments)).not.toContain("secret")
    expect(fallbackAttachmentViews(["/Users/alice/failed.md"], true)[0]?.status).toBe("failed")
  })

  test("requests a preview for a selected job attachment regardless of status", async () => {
    const calls: Array<{ id: string; attachmentID: string }> = []
    const client = {
      attachmentPreview: async (input: { id: string; attachmentID: string }) => {
        calls.push(input)
        return { name: "report.pdf", mime: "application/pdf", base64: "JVBERg==" }
      },
    }
    const [ready, failed, pending] = attachmentViews([
      { id: "ready-id", name: "report.pdf", status: "ready" },
      { id: "failed-id", name: "broken.pdf", status: "failed" },
      { id: "pending-id", name: "queued.txt", status: "pending" },
    ])

    expect(await fetchGptProAttachmentPreview(client, "job-1", ready!)).toEqual({
      name: "report.pdf",
      mime: "application/pdf",
      base64: "JVBERg==",
    })
    await fetchGptProAttachmentPreview(client, "job-1", failed!)
    await fetchGptProAttachmentPreview(client, "job-1", pending!)
    expect(calls).toEqual([
      { id: "job-1", attachmentID: "ready-id" },
      { id: "job-1", attachmentID: "failed-id" },
      { id: "job-1", attachmentID: "pending-id" },
    ])
    const emptyClient = {
      attachmentPreview: async () => ({ name: "empty.txt", mime: "text/plain", base64: "" }),
    }
    const [empty] = attachmentViews([{ id: "empty-id", name: "empty.txt", status: "ready" }])
    const emptyPreview = await fetchGptProAttachmentPreview(emptyClient, "job-1", empty!)
    expect(emptyPreview?.base64).toBe("")
    expect(isValidGptProAttachmentPreview(emptyPreview)).toBe(true)
  })

  test("renders attachment capsules below the tool row through the Solid UI transform", async () => {
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
      const { renderToStringAsync } = await server.ssrLoadModule("solid-js/web")
      const html = await renderToStringAsync(() =>
        component.GptProTool({
          status: "error",
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
      expect(html).toContain('data-attachment-status="ready"')
      expect(html).toContain('data-testid="gpt-pro-attachments-below"')
      expect(html).toContain('data-component="file-icon"')
      expect(html).toContain('aria-label="Preview notes.txt (Ready)"')
      expect(html).not.toContain('data-testid="gpt-pro-attachments-inline"')
      expect(html.indexOf('data-slot="basic-tool-tool-action"')).toBeLessThan(
        html.indexOf('data-testid="gpt-pro-attachments-below"'),
      )
      expect(html).not.toContain("/private/")
      expect(html).not.toContain("secret")
    } finally {
      await server.close()
    }
  })

  test("renders pre-job file inputs as unknown capsules without pretending they can be previewed", async () => {
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
        component.GptProTool({ status: "error", input: { files: ["/private/preflight.md"] }, metadata: {} }),
      )
      expect(html).toContain("preflight.md")
      expect(html).toContain('data-attachment-status="failed"')
      expect(html).toContain("disabled")
      expect(html).not.toContain("/private/")
    } finally {
      await server.close()
    }
  })
  test("renders why a queued consultation is waiting", async () => {
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
      const capacity = renderToString(() =>
        component.GptProTool({ status: "running", input: {}, metadata: { phase: "queued", queue_reason: "capacity" } }),
      )
      expect(capacity).toContain("Waiting for an available consultation slot")
      expect(capacity).toContain('data-queue-reason="capacity"')
      const pageCapacity = renderToString(() =>
        component.GptProTool({ status: "running", input: {}, metadata: { phase: "queued", queue_reason: "page_capacity" } }),
      )
      expect(pageCapacity).toContain("Waiting for a resident consultation page to become available")
      expect(pageCapacity).toContain('data-queue-reason="page_capacity"')
      const ownerBusy = renderToString(() =>
        component.GptProTool({
          status: "running",
          input: {},
          metadata: {
            phase: "queued",
            queue_reason: "owner_busy",
            queue_owner_consultation_id: "gpt_owner_job",
          },
        }),
      )
      expect(ownerBusy).toContain("gpt_owner_job")
      expect(ownerBusy).toContain('data-queue-reason="owner_busy"')
    } finally {
      await server.close()
    }
  })
  test("renders cached result text through the shared Markdown component without injecting result HTML", async () => {
    const server = await createServer({
      configFile: false,
      plugins: [solid({ solid: { generate: "ssr" } })],
      resolve: { alias: { "@": fileURLToPath(new URL("../../../app/src", import.meta.url)) } },
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    })
    try {
      const component = await server.ssrLoadModule(
        fileURLToPath(new URL("./gpt-pro-result-preview.tsx", import.meta.url)),
      )
      const marked = await server.ssrLoadModule(fileURLToPath(new URL("../context/marked.tsx", import.meta.url)))
      const { renderToString } = await server.ssrLoadModule("solid-js/web")
      const html = renderToString(() =>
        marked.MarkedProvider({
          children: () =>
            component.GptProResultPreviewContent({
            state: {
              open: true,
              loading: false,
              opening: false,
              error: "",
              result: {
                id: "gpt_cached_preview",
                phase: "completed",
                url: "https://chatgpt.com/c/gpt_cached_preview",
                text: "Cached answer\n\n<script>unsafe result content</script>",
                source: "read",
              },
            },
            }),
        }),
      )
      expect(html).toContain("Cached answer")
      expect(html).not.toContain("<script>")
      expect(html).not.toContain("onerror=")
    } finally {
      await server.close()
    }
  })
})
