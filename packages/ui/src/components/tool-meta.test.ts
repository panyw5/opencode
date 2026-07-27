import { describe, expect, test } from "bun:test"
import { isCustomHookTool, normalizeTool } from "./tool-meta"

describe("tool-meta normalizeTool", () => {
  test("maps supported external tool aliases to built-in renderers", () => {
    expect(normalizeTool("terminal")).toBe("bash")
    expect(normalizeTool("read_file")).toBe("read")
    expect(normalizeTool("web_search")).toBe("websearch")
  })

  test("leaves unsupported aliases alone", () => {
    expect(normalizeTool("write_file")).toBe("write_file")
    expect(normalizeTool("web_extract")).toBe("web_extract")
    expect(normalizeTool("patch")).toBe("patch")
  })
})

describe("tool-meta isCustomHookTool", () => {
  test("treats the dedicated hook tool as a custom hook", () => {
    expect(isCustomHookTool("hook", {}, {})).toBe(true)
  })

  test("supports legacy bash hooks with explicit hook metadata", () => {
    expect(
      isCustomHookTool(
        "bash",
        { description: "before session-start hook" },
        { hook_name: "session-start", hook_type: "before" },
      ),
    ).toBe(true)
  })

  test("requires both legacy hook name and hook type", () => {
    expect(isCustomHookTool("bash", {}, { hook: "session-start" })).toBe(false)
    expect(isCustomHookTool("bash", {}, { hook_type: "before" })).toBe(false)
  })

  test("does not hide ordinary external tools like hermes search_files", () => {
    expect(isCustomHookTool("search_files", { pattern: "apps" }, {})).toBe(false)
    expect(isCustomHookTool("terminal", { command: "date" }, {})).toBe(false)
  })

  test("does not mistake hyphenated command names in a shell description for hooks", () => {
    expect(
      isCustomHookTool(
        "bash",
        { command: "which yt-dlp || which youtube-dl", description: "检查 yt-dlp 或 youtube-dl 是否已安装" },
        { exit: 0, jobId: "job_1" },
      ),
    ).toBe(false)
  })

  test("does not classify generic shell metadata as a hook", () => {
    expect(
      isCustomHookTool(
        "bash",
        { command: "deploy", name: "deploy-task", description: "before session-start hook" },
        { event: "job-start", stage: "before", phase: "prepare" },
      ),
    ).toBe(false)
  })
})
