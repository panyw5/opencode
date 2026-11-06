import { expect, test } from "bun:test"
import { canHighlightWolfram, MAX_HIGHLIGHT_CHARACTERS, MAX_HIGHLIGHT_TOKENS, tokenizeWolfram } from "../src/highlight"

test("colors Wolfram functions, constants, numbers, strings and patterns", () => {
  const source = 'f[x_Real, n__:2] := Module[{q = 1.25`30*^-6}, Print["hello"]; Sin[x] + Pi + #2 &]'
  const tokens = tokenizeWolfram(source)
  expect(tokens.map((token) => token.text).join("")).toBe(source)
  expect(tokens).toContainEqual({ kind: "function", text: "Module" })
  expect(tokens).toContainEqual({ kind: "function", text: "Sin" })
  expect(tokens).toContainEqual({ kind: "function", text: "f" })
  expect(tokens).toContainEqual({ kind: "constant", text: "Pi" })
  expect(tokens).toContainEqual({ kind: "number", text: "1.25`30*^-6" })
  expect(tokens).toContainEqual({ kind: "string", text: '"hello"' })
  expect(tokens).toContainEqual({ kind: "pattern", text: "__" })
  expect(tokens).toContainEqual({ kind: "pattern", text: "#2" })
})

test("nested comments and escaped/multiline strings remain single tokens", () => {
  const source = '(* outer (* inner *) "still comment" *)\n"hello \\"world\\"\nmore"'
  const tokens = tokenizeWolfram(source)
  expect(tokens[0]).toEqual({ kind: "comment", text: '(* outer (* inner *) "still comment" *)' })
  expect(tokens).toHaveLength(3)
  expect(tokens.at(-1)).toEqual({ kind: "string", text: '"hello \\"world\\"\nmore"' })
  expect(tokens.map((token) => token.text).join("")).toBe(source)
})

test("handles Unicode, named characters, contexts and base/precision numbers", () => {
  const source = "System`Sin[\u03b1] + \\[Chi] \\[Rule] .5 + 16^^ff + 2.0``20 + $Failed"
  const tokens = tokenizeWolfram(source)
  expect(tokens.map((token) => token.text).join("")).toBe(source)
  expect(tokens).toContainEqual({ kind: "symbol", text: "α" })
  expect(tokens).toContainEqual({ kind: "symbol", text: String.raw`\[Chi]` })
  expect(tokens).toContainEqual({ kind: "operator", text: String.raw`\[Rule]` })
  expect(tokens).toContainEqual({ kind: "number", text: "16^^ff" })
  expect(tokens).toContainEqual({ kind: "number", text: "2.0``20" })
  expect(tokens).toContainEqual({ kind: "function", text: "System`Sin" })
  expect(tokens).toContainEqual({ kind: "constant", text: "$Failed" })
})

test("incomplete edits and HTML-like strings preserve exact text without markup", () => {
  for (const source of [
    "",
    "\n",
    "(* unfinished (* comment",
    'Print["unfinished',
    '"<img src=x onerror=alert(1)>"',
    "x +\n",
    "f[x___] := ##1 + %%",
  ]) {
    expect(
      tokenizeWolfram(source)
        .map((token) => token.text)
        .join(""),
    ).toBe(source)
  }
})

test("token count stays bounded even within the character budget", () => {
  const source = "+".repeat(MAX_HIGHLIGHT_TOKENS + 100)
  const tokens = tokenizeWolfram(source)
  expect(tokens).toHaveLength(MAX_HIGHLIGHT_TOKENS + 1)
  expect(tokens.at(-1)?.kind).toBe("plain")
  expect(tokens.map((token) => token.text).join("")).toBe(source)
})

test("character budget is checked before scanning a single huge token", () => {
  for (const source of [
    "(*" + "x".repeat(MAX_HIGHLIGHT_CHARACTERS),
    '"' + "x".repeat(MAX_HIGHLIGHT_CHARACTERS),
    "x".repeat(MAX_HIGHLIGHT_CHARACTERS + 1),
    " ".repeat(MAX_HIGHLIGHT_CHARACTERS + 1),
    "\\[" + "a".repeat(MAX_HIGHLIGHT_CHARACTERS),
    "α🙂".repeat(MAX_HIGHLIGHT_CHARACTERS),
  ]) {
    expect(canHighlightWolfram(source)).toBe(false)
    expect(tokenizeWolfram(source)).toEqual([{ kind: "plain", text: source }])
  }
  const boundary = "x".repeat(MAX_HIGHLIGHT_CHARACTERS)
  expect(canHighlightWolfram(boundary)).toBe(true)
  expect(tokenizeWolfram(boundary)).toEqual([{ kind: "symbol", text: boundary }])
})

test("very large cells retain all text with a bounded number of highlight spans", () => {
  const source = "Sin[x] + 1; ".repeat(20_000)
  const tokens = tokenizeWolfram(source)
  expect(tokens.length).toBeLessThanOrEqual(MAX_HIGHLIGHT_TOKENS + 1)
  expect(tokens.at(-1)?.kind).toBe("plain")
  expect(tokens.map((token) => token.text).join("")).toBe(source)
})
