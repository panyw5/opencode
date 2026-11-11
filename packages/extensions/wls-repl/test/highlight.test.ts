import { expect, test } from "bun:test"
import { createWlsHighlight, HIGHLIGHT_CACHE_LINES } from "../src/highlight"

function indexed(source: string, budget = 100) {
  const lines = source.split("\n")
  const index = createWlsHighlight(source, lines)
  let count = 0
  while (!index.advance(budget)) {
    if (++count > source.length + lines.length) throw new Error("Index did not finish")
  }
  return { index, lines }
}

test("preserves exact lines and cross-line nested comment and string state", () => {
  const source = '(* outer\n(* nested *)\nend *) Sin[x];\n"hello\\\nworld \\\" quoted\nend" + Pi\n\n'
  const { index, lines } = indexed(source, 1)
  for (let row = 0; row < lines.length; row++) {
    expect(
      index
        .tokens(row)
        .map((token) => token.text)
        .join(""),
    ).toBe(lines[row])
  }
  expect(index.tokens(1)).toEqual([{ kind: "comment", text: "(* nested *)" }])
  expect(index.tokens(2)).toContainEqual({ kind: "function", text: "Sin" })
  expect(index.tokens(4)[0].kind).toBe("string")
  expect(index.tokens(5)).toContainEqual({ kind: "constant", text: "Pi" })
})

test("file tail stays highlighted beyond notebook character and token budgets", () => {
  const source = Array.from({ length: 10000 }, (_, i) => `value${i} = Sin[${i}] + Pi;`).join("\n")
  const { index } = indexed(source, 16384)
  expect(source.length).toBeGreaterThan(65536)
  expect(index.tokens(9999)).toContainEqual({ kind: "function", text: "Sin" })
  expect(index.tokens(9999)).toContainEqual({ kind: "number", text: "9999" })
  for (let i = 0; i < 1000; i++) index.tokens(i)
  expect(index.cachedLines).toBe(HIGHLIGHT_CACHE_LINES)
})

test("long lines degrade locally while their lexical state still propagates", () => {
  const source = "(*" + "x".repeat(100000) + "\nstill comment *)\nSin[x]"
  const { index, lines } = indexed(source, 1024)
  expect(index.tokens(0)).toEqual([{ kind: "plain", text: lines[0] }])
  expect(index.tokens(1)).toEqual([{ kind: "comment", text: "still comment *)" }])
  expect(index.tokens(2)).toContainEqual({ kind: "function", text: "Sin" })
})

test("per-line token limits do not lose text or later comment state", () => {
  const source = "a+".repeat(5000) + "(*\ncomment *)\nSin[x]"
  const { index, lines } = indexed(source)
  expect(index.tokens(0).length).toBeLessThanOrEqual(4001)
  expect(
    index
      .tokens(0)
      .map((token) => token.text)
      .join(""),
  ).toBe(lines[0])
  expect(index.tokens(1)).toEqual([{ kind: "comment", text: "comment *)" }])
  expect(index.tokens(2)).toContainEqual({ kind: "function", text: "Sin" })
})

test("unindexed content remains text and disposed tasks cannot update a new file", () => {
  const source = "(*\n" + "text\n".repeat(100) + '*)\nPrint["<img src=x onerror=alert(1)>"]'
  const index = createWlsHighlight(source, source.split("\n"))
  expect(index.tokens(50)).toEqual([{ kind: "plain", text: "text" }])
  index.advance(4)
  const progress = index.indexedLines
  index.dispose()
  expect(index.advance()).toBe(true)
  expect(index.indexedLines).toBe(progress)
  expect(index.cachedLines).toBe(0)
  const fresh = indexed('Print["<img src=x onerror=alert(1)>"]').index
  expect(fresh.tokens(0)).toContainEqual({ kind: "string", text: '"<img src=x onerror=alert(1)>"' })
})
