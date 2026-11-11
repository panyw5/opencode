import { expect, test } from "bun:test"
import { scanWolfram, tokenizeWolfram, wolframCursor, type WolframToken } from "../src/wolfram"

function merged(tokens: WolframToken[]) {
  const result: WolframToken[] = []
  for (const token of tokens) {
    const previous = result.at(-1)
    if (previous?.kind === token.kind) previous.text += token.text
    else result.push({ ...token })
  }
  return result
}

test("resumable scanning preserves lexical state at every character boundary", () => {
  const source = '(* outer\n(* inner *) end *)\nf[x_] := "escaped \\\" text\nmore"; System`Sin[α] + 1.2`20*^-3 + #2 &'
  for (const size of [1, 2, 7, 64]) {
    const cursor = wolframCursor()
    const tokens: WolframToken[] = []
    while (cursor.offset < source.length) {
      scanWolfram(
        source,
        cursor,
        (kind, start, end) => tokens.push({ kind, text: source.slice(start, end) }),
        cursor.offset + size,
      )
    }
    expect(tokens.map((token) => token.text).join("")).toBe(source)
    expect(merged(tokens)).toEqual(merged(tokenizeWolfram(source)))
    expect(cursor.commentDepth).toBe(0)
    expect(cursor.string).toBe(false)
  }
})
