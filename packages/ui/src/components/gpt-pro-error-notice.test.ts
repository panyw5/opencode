import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import { GPT_PRO_ISSUE_CODES } from "@opencode-ai/util/gpt-pro-error"
import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"

describe("GPT-Pro user guidance", () => {
  test("every issue has English and Chinese instructions, including unavailable result fallback", () => {
    for (const code of GPT_PRO_ISSUE_CODES) {
      for (const field of ["title", "hint"]) {
        const key = `ui.tool.gptPro.error.${code}.${field}`
        expect(en[key]?.length).toBeGreaterThan(5)
        expect((zh as Record<string, string>)[key]?.length).toBeGreaterThan(3)
      }
    }
    expect(en["ui.tool.gptPro.resultUnavailable"]).toBeDefined()
    expect(zh["ui.tool.gptPro.resultUnavailable"]).toBeDefined()
  })
  test("renders guidance, collapsed safe details, queue status, and no unsafe resume button", async () => {
    const server = await createServer({
      configFile: false,
      plugins: [solid({ solid: { generate: "ssr" } })],
      resolve: { alias: { "@": fileURLToPath(new URL("../../../app/src", import.meta.url)) } },
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    })
    try {
      const notice = await server.ssrLoadModule(fileURLToPath(new URL("./gpt-pro-error-notice.tsx", import.meta.url)))
      const tool = await server.ssrLoadModule(fileURLToPath(new URL("./gpt-pro-tool.tsx", import.meta.url)))
      const { renderToString } = await server.ssrLoadModule("solid-js/web")
      const html = renderToString(() =>
        notice.GptProErrorNotice({
          error: "Error invoking remote method 'gpt-pro-command': Error: HTTP 401\nCookie: private-secret",
        }),
      )
      expect(html).toContain("ChatGPT login is required")
      expect(html).toContain("External agents")
      expect(html).toContain("<details>")
      expect(html).not.toContain("<details open")
      expect(html).not.toContain("private-secret")
      expect(html).not.toContain("Error invoking remote method")
      const unknown = renderToString(() => notice.GptProErrorNotice({ error: "<img src=x onerror=alert(1)>" }))
      expect(unknown).toContain("The consultation needs attention")
      expect(unknown).not.toContain("<img")
      const queue = renderToString(() => notice.GptProErrorNotice({ phase: "queued", queueReason: "page_capacity" }))
      expect(queue).toContain('role="status"')
      expect(queue).toContain("resident page limit")
      const uncertain = renderToString(() =>
        tool.GptProTool({
          status: "completed",
          input: {},
          metadata: {
            phase: "paused",
            consultation_id: "gpt_uncertain",
            send_attempted: true,
            error: "Submission is uncertain. Do not resend.",
          },
        }),
      )
      expect(uncertain).toContain("Do not resend or start a replacement consultation")
      expect(uncertain).not.toContain("Continue consultation</span>")
      expect(uncertain).not.toContain("Continue the same consultation. Sent questions")
      const stopped = renderToString(() =>
        tool.GptProTool({ status: "completed", input: {}, metadata: { phase: "cancelled" } }),
      )
      expect(stopped).not.toContain('role="alert"')
      const startup = renderToString(() =>
        tool.GptProTool({
          status: "error",
          input: {},
          metadata: {},
          error:
            "Error invoking remote method 'gpt-pro-command': Error: Enable gpt-pro in Settings > External Agents first.",
        }),
      )
      expect(startup).toContain("GPT-Pro is not enabled")
      expect(startup).toContain("connect your ChatGPT login")
    } finally {
      await server.close()
    }
  })
})
