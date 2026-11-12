import { describe, expect, test } from "bun:test"
import { prettyLines, type Pretty } from "../src/pretty"

// Serialize display nodes back to a shape easy to assert on.
function dump(node: Pretty): unknown {
  switch (node.kind) {
    case "tok":
      return node.text
    case "frac":
      return { frac: [node.num.map(dump), node.den.map(dump)] }
    case "sup":
      return { sup: [node.base.map(dump), node.exp.map(dump)] }
    case "sub":
      return { sub: [node.base.map(dump), node.sub.map(dump)] }
    case "sqrt":
      return { sqrt: node.arg.map(dump) }
    case "group":
      return [node.open, ...node.inner.map(dump), ...(node.close ? [node.close] : [])]
  }
}
const line = (source: string) => prettyLines(source)[0].map(dump)
const flat = (items: unknown[]): string => JSON.stringify(items)

describe("prettyLines", () => {
  test("fraction binds immediate operands", () => {
    // A sole (...) operand is unwrapped: the bar already groups it.
    expect(line("(a+b)/2")).toEqual([{ frac: [["a", "+", "b"], ["2"]] }])
  })
  test("fraction unwraps both parenthesized operands", () => {
    expect(line("(x+y)/(x-y)")).toEqual([{ frac: [["x", "+", "y"], ["x", "-", "y"]] }])
    // unclosed or non-paren wrappers stay put
    expect(line("x/[a+b]")[0]).toEqual({ frac: [["x"], [["[", "a", "+", "b", "]"]]] })
  })
  test("groups carrying fractions are marked tall", () => {
    const hasTall = (src: string): boolean =>
      prettyLines(src)[0].some((n) => n.kind === "group" && n.tall)
    expect(hasTall("f[(a/b)]")).toBe(true)
    expect(hasTall("f[a/b]")).toBe(true)
    expect(hasTall("g[h[(a/b)]]")).toBe(true)
    expect(hasTall("{a/b, c}")).toBe(true)
    expect(hasTall("f[x]")).toBe(false)
    expect(hasTall("Sum[x, {i, n}]")).toBe(false)
    // sqrt only makes a group tall when its argument is tall too
    expect(hasTall("f[Sqrt[a/b]]")).toBe(true)
    expect(hasTall("f[Sqrt[x]]")).toBe(false)
  })
  test("fraction keeps implicit-times factor after the denominator", () => {
    // 1/2 (a+b) typesets as a unit fraction followed by the group.
    const result = line("1/2 (a+b)")
    expect(result[0]).toEqual({ frac: [["1"], ["2"]] })
    expect(result[2]).toEqual(["(", "a", "+", "b", ")"])
  })
  test("left associative division chain nests", () => {
    const [frac] = line("a/b/c") as [{ frac: [unknown[], unknown[]] }]
    expect(frac.frac[1]).toEqual(["c"])
    expect(frac.frac[0]).toEqual([{ frac: [["a"], ["b"]] }])
  })
  test("power renders superscript right-associatively", () => {
    expect(line("x^2")).toEqual([{ sup: [["x"], ["2"]] }])
    const [nested] = line("x^y^z") as [{ sup: [unknown[], unknown[]] }]
    expect(nested.sup[0]).toEqual(["x"])
    expect(nested.sup[1]).toEqual([{ sup: [["y"], ["z"]] }])
  })
  test("power inside fraction denominator", () => {
    const [frac] = line("a/b^2") as [{ frac: [unknown[], unknown[]] }]
    expect(frac.frac[0]).toEqual(["a"])
    expect(frac.frac[1]).toEqual([{ sup: [["b"], ["2"]] }])
  })
  test("operator glyphs", () => {
    expect(flat(line("i <= 2 r && x != y -> z"))).toContain('"≤"')
    expect(flat(line("i <= 2 r && x != y -> z"))).toContain('"∧"')
    expect(flat(line("i <= 2 r && x != y -> z"))).toContain('"≠"')
    expect(flat(line("i <= 2 r && x != y -> z"))).toContain('"→"')
  })
  test("named characters render unicode", () => {
    expect(flat(line("\\[Alpha] + \\[Beta]"))).toContain('"α"')
    expect(flat(line("\\[Alpha] + \\[Beta]"))).toContain('"β"')
  })
  test("implicit multiplication keeps space", () => {
    expect(line("2 r")).toEqual(["2", " ", "r"])
  })
  test("calls and lists stay linear", () => {
    const out = line("Sum[hh[j], {j, i, 2 r}]")
    expect(flat(out)).toBe(
      '["Sum",["[","hh",["[","j","]"],","," ",["{","j",","," ","i",","," ","2"," ","r","}"],"]"]]',
    )
  })
  test("patterns stay linear", () => {
    expect(flat(line("HH[i_ /; i <= 2 r]"))).toContain('"/;"')
    expect(flat(line("f[x_Integer]"))).toContain('"_"')
  })
  test("subscript and sqrt calls", () => {
    expect(line("Subscript[x, i]")).toEqual([{ sub: [["x"], ["i"]] }])
    expect(line("Sqrt[x]")).toEqual([{ sqrt: ["x"] }])
  })
  test("unary minus wraps power", () => {
    const items = line("-x^2")
    expect(items[0]).toBe("-")
    expect(items[1]).toEqual({ sup: [["x"], ["2"]] })
  })
  test("multiple lines split", () => {
    const lines = prettyLines("a = 1\nb = (c+d)/2")
    expect(lines.length).toBe(2)
    expect(JSON.stringify(lines[1].map(dump))).toContain('"frac"')
  })
  test("derivative postfix", () => {
    expect(flat(line("hh[i]'"))).toContain('"\'"')
  })
})
