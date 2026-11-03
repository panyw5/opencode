import { describe, expect, test } from "bun:test"
import { prettyDefinition, stripNamePrefix } from "../src/web"

describe("prettyDefinition", () => {
  test("renders own values with =", () => {
    expect(prettyDefinition("HoldPattern[a] :> 1")).toBe("a = 1")
    expect(prettyDefinition("HoldPattern[t] :> {1, 4, 9}")).toBe("t = {1, 4, 9}")
  })

  test("renders function definitions with :=", () => {
    expect(prettyDefinition("HoldPattern[ff[x_]] :> x + 1")).toBe("ff[x_] := x + 1")
    expect(prettyDefinition("HoldPattern[gg[y_][z_]] :> y*z")).toBe("gg[y_][z_] := y*z")
  })

  test("joins multiple parts and leaves empties out", () => {
    expect(prettyDefinition("HoldPattern[a] :> 1; HoldPattern[f[x_]] :> x")).toBe("a = 1; f[x_] := x")
    expect(prettyDefinition("")).toBe("")
  })
})

describe("stripNamePrefix", () => {
  test("drops a redundant leading name assignment", () => {
    expect(stripNamePrefix("label", 'label = "mean is 11"')).toBe('"mean is 11"')
    expect(stripNamePrefix("f", "f[x_] := x + 1")).toBe("f[x_] := x + 1")
    expect(stripNamePrefix("a", "a = 1")).toBe("1")
  })

  test("keeps text that does not start with the name", () => {
    expect(stripNamePrefix("a", "b = 1")).toBe("b = 1")
    expect(stripNamePrefix("a", "a2 = 1")).toBe("a2 = 1")
  })
})
