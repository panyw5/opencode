import { describe, expect, test } from "bun:test"
import { codeFileLanguage } from "./file-language"

describe("file language detection", () => {
  test("maps Wolfram file extensions to Shiki's wolfram language", () => {
    expect(codeFileLanguage("VOA.wls")).toBe("wolfram")
    expect(codeFileLanguage("package.wl")).toBe("wolfram")
    expect(codeFileLanguage("notebook.nb")).toBe("wolfram")
    expect(codeFileLanguage("legacy.mma")).toBe("wolfram")
  })

  test("maps common source extensions to supported language ids", () => {
    expect(codeFileLanguage("src/app.tsx")).toBe("tsx")
    expect(codeFileLanguage("script.py")).toBe("python")
    expect(codeFileLanguage("data.jsonl")).toBe("jsonl")
    expect(codeFileLanguage("deploy.sh")).toBe("zsh")
  })
})
