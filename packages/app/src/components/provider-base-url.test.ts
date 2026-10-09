import { describe, expect, test } from "bun:test"
import {
  hasProviderV1,
  pasteProviderBaseURL,
  resolveProviderBaseURL,
  stripProviderV1,
  usesProviderV1,
} from "./provider-base-url"

describe("provider base URL", () => {
  test.each([
    ["https://api.example.com", "https://api.example.com/v1"],
    [" https://api.example.com/// ", "https://api.example.com/v1"],
    ["https://api.example.com/v1/", "https://api.example.com/v1"],
    ["https://api.example.com/proxy/v1", "https://api.example.com/proxy/v1"],
    ["https://api.example.com?token=abc#part", "https://api.example.com/v1?token=abc#part"],
    ["https://api.example.com/v1/?token=abc", "https://api.example.com/v1?token=abc"],
    ["", ""],
  ])("resolves %s without duplicate v1", (input, expected) => {
    expect(resolveProviderBaseURL(input, "@ai-sdk/openai")).toBe(expected)
    expect(resolveProviderBaseURL(expected, "@ai-sdk/openai")).toBe(expected)
  })

  test("hides only the terminal v1 path when loading or pasting", () => {
    expect(stripProviderV1(" https://api.example.com/proxy/v1/ ", "@ai-sdk/openai")).toBe(
      "https://api.example.com/proxy",
    )
    expect(stripProviderV1("https://api.example.com/v1beta", "@ai-sdk/openai")).toBe("https://api.example.com/v1beta")
    expect(stripProviderV1("https://api.example.com/v1/proxy", "@ai-sdk/openai")).toBe(
      "https://api.example.com/v1/proxy",
    )
    expect(hasProviderV1("https://api.example.com/v1/ ")).toBe(true)
    expect(hasProviderV1("https://api.example.com/v10")).toBe(false)
  })

  test("preserves protocols with different version paths", () => {
    for (const npm of [
      undefined,
      "@ai-sdk/openai-compatible",
      "@ai-sdk/google",
      "@ai-sdk/cohere",
      "@ai-sdk/azure",
      "@ai-sdk/google-vertex",
      "@ai-sdk/amazon-bedrock",
      "custom-sdk",
    ]) {
      expect(usesProviderV1(npm)).toBe(false)
      expect(resolveProviderBaseURL("https://api.example.com/v1beta", npm)).toBe("https://api.example.com/v1beta")
      expect(stripProviderV1("https://api.example.com/v1", npm)).toBe("https://api.example.com/v1")
      expect(resolveProviderBaseURL("https://api.example.com/custom", npm)).toBe("https://api.example.com/custom")
    }
    expect(usesProviderV1(" @AI-SDK/ANTHROPIC ")).toBe(true)
  })

  test("pastes at the selected range and restores the caret", () => {
    expect(pasteProviderBaseURL("replace", "https://api.example.com/v1/", 0, 7, "@ai-sdk/openai")).toEqual({
      value: "https://api.example.com",
      caret: 23,
    })
    expect(pasteProviderBaseURL("https://old/path", "new/v1", 8, 11, "@ai-sdk/openai")).toEqual({
      value: "https://new/path",
      caret: 11,
    })
    expect(pasteProviderBaseURL("", "https://api.example.com/v1", 0, 0, "@ai-sdk/google").value).toBe(
      "https://api.example.com/v1",
    )
  })

  test.each([
    ["@ai-sdk/openai", "https://api.openai.com/v1"],
    ["@ai-sdk/anthropic", "https://api.anthropic.com/v1"],
    ["@ai-sdk/groq", "https://api.groq.com/openai/v1"],
    ["@ai-sdk/mistral", "https://api.mistral.ai/v1"],
    ["@ai-sdk/alibaba", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["@openrouter/ai-sdk-provider", "https://openrouter.ai/api/v1"],
    ["@ai-sdk/xai", "https://api.x.ai/v1"],
    ["@ai-sdk/togetherai", "https://api.together.xyz/v1"],
    ["@ai-sdk/cerebras", "https://api.cerebras.ai/v1"],
    ["@ai-sdk/deepinfra", "https://api.deepinfra.com/v1"],
  ])("offers v1 only for verified %s defaults", (npm, baseURL) => {
    expect(usesProviderV1(npm)).toBe(true)
    expect(resolveProviderBaseURL(stripProviderV1(baseURL, npm), npm)).toBe(baseURL)
  })
})
