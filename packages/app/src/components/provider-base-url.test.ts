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
    expect(resolveProviderBaseURL(input)).toBe(expected)
    expect(resolveProviderBaseURL(expected)).toBe(expected)
  })

  test("hides only the terminal v1 path when loading or pasting", () => {
    expect(stripProviderV1(" https://api.example.com/proxy/v1/ ")).toBe("https://api.example.com/proxy")
    expect(stripProviderV1("https://api.example.com/v1beta")).toBe("https://api.example.com/v1beta")
    expect(stripProviderV1("https://api.example.com/v1/proxy")).toBe("https://api.example.com/v1/proxy")
    expect(hasProviderV1("https://api.example.com/v1/ ")).toBe(true)
    expect(hasProviderV1("https://api.example.com/v10")).toBe(false)
  })

  test("preserves protocols with different version paths", () => {
    for (const npm of ["@ai-sdk/google", "custom-sdk", "@ai-sdk/azure"]) {
      expect(usesProviderV1(npm)).toBe(false)
      expect(resolveProviderBaseURL("https://api.example.com/v1beta", npm)).toBe("https://api.example.com/v1beta")
      expect(stripProviderV1("https://api.example.com/v1", npm)).toBe("https://api.example.com/v1")
    }
    expect(usesProviderV1(" @AI-SDK/ANTHROPIC ")).toBe(true)
  })

  test("pastes at the selected range and restores the caret", () => {
    expect(pasteProviderBaseURL("replace", "https://api.example.com/v1/", 0, 7)).toEqual({
      value: "https://api.example.com",
      caret: 23,
    })
    expect(pasteProviderBaseURL("https://old/path", "new/v1", 8, 11)).toEqual({
      value: "https://new/path",
      caret: 11,
    })
    expect(pasteProviderBaseURL("", "https://api.example.com/v1", 0, 0, "@ai-sdk/google").value).toBe(
      "https://api.example.com/v1",
    )
  })
})
