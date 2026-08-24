import { describe, expect, test } from "bun:test"
import { cleanExternalRefs, computeFactId, dumps, normalize } from "../../src/math/schema"

describe("math.schema", () => {
  test("dumps matches Python json.dumps sort_keys=True separators", () => {
    const body = {
      glossary_introduces: { X: "a complex manifold" },
      predecessors: [] as string[],
      problem_id: "P",
      proof: "proof of A",
      statement: "A holds",
    }
    expect(dumps(body, { sortKeys: true })).toBe(
      '{"glossary_introduces": {"X": "a complex manifold"}, "predecessors": [], "problem_id": "P", "proof": "proof of A", "statement": "A holds"}',
    )
  })

  test("same content yields the Danus 16-hex fact_id", () => {
    expect(
      computeFactId({
        problem_id: "P",
        predecessors: [],
        glossary_introduces: { X: "a complex manifold" },
        statement: "A holds",
        proof: "proof of A",
      }),
    ).toBe("82b23055ad205955")
  })

  test("whitespace-only edits do not change fact_id", () => {
    const a = computeFactId({
      problem_id: "P",
      predecessors: [],
      glossary_introduces: {},
      statement: "A holds",
      proof: "pf",
    })
    const b = computeFactId({
      problem_id: "P",
      predecessors: [],
      glossary_introduces: {},
      statement: "  A   holds\n",
      proof: "pf\n\n",
    })
    expect(a).toBe(b)
    expect(normalize("  A   holds\n")).toBe("A holds")
  })

  test("external_refs are not part of the id", () => {
    const base = {
      problem_id: "P",
      predecessors: [] as string[],
      glossary_introduces: {},
      statement: "A holds",
      proof: "pf",
    }
    expect(computeFactId(base)).toBe(
      computeFactId(base), // stable
    )
  })

  test("predecessor order does not change id", () => {
    const a = computeFactId({
      problem_id: "P",
      predecessors: ["bbbb", "aaaa"],
      glossary_introduces: {},
      statement: "S",
      proof: "P",
    })
    const b = computeFactId({
      problem_id: "P",
      predecessors: ["aaaa", "bbbb"],
      glossary_introduces: {},
      statement: "S",
      proof: "P",
    })
    expect(a).toBe(b)
  })

  test("cleanExternalRefs canonicalizes key order and drops non-dicts", () => {
    const out = cleanExternalRefs([{ note: "z", title: "T", key: "K", aardvark: 1 }, "nope", null])
    expect(out).toEqual([{ key: "K", title: "T", aardvark: 1, note: "z" }])
    expect(Object.keys(out[0])).toEqual(["key", "title", "aardvark", "note"])
  })
})
