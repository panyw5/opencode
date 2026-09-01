import { describe, expect, test } from "bun:test"
import { bm25Scores, tokenize } from "../../src/math/bm25"

describe("math.bm25", () => {
  test("tokenize is lowercase alnum/underscore", () => {
    expect(tokenize("Reduce to q>=2 Case!")).toEqual(["reduce", "to", "q", "2", "case"])
  })

  test("empty query or corpus yields zeros", () => {
    expect(bm25Scores("", [["a"], ["b"]])).toEqual([0, 0])
    expect(bm25Scores("a", [])).toEqual([])
  })

  test("ranking prefers the document that mentions the query more", () => {
    const docs = [tokenize("plan reduce to the q case"), tokenize("unrelated symplectic leaf"), tokenize("reduce reduce reduce")]
    const scores = bm25Scores("reduce", docs)
    expect(scores[2]).toBeGreaterThan(scores[0])
    expect(scores[0]).toBeGreaterThan(scores[1])
    expect(scores[1]).toBe(0)
  })
})
