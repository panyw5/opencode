import { expect, test } from "bun:test"
import { formatWolfram } from "../src/format"

const A = "<" + "|"
const Z = "|" + ">"

test("spaces binary operators and keeps tight ones tight", () => {
  expect(formatWolfram("x=a+1;y=b-2;z=c*d;")).toBe("x = a + 1;\ny = b - 2;\nz = c * d;\n")
  expect(formatWolfram("a===b&&c||!d;")).toBe("a === b && c || !d;\n")
  expect(formatWolfram("e/;f;g@@h;i/@j;k//l;m/.n->o;p:=q;")).toBe(
    "e /; f;\ng @@ h;\ni /@ j;\nk // l;\nm /. n -> o;\np := q;\n",
  )
})

test("separates statements after semicolons", () => {
  expect(formatWolfram("a=1;b=2")).toBe("a = 1;\nb = 2\n")
  expect(formatWolfram("Do[x;y,{i,3}]")).toBe("Do[x; y, {i, 3}]\n")
})

test("breaks long groups but keeps short ones inline", () => {
  expect(formatWolfram("g={1,2,3};")).toBe("g = {1, 2, 3};\n")
  const long = `list={${Array.from({ length: 26 }, (_, i) => i + 1).join(",")}};`
  expect(formatWolfram(long)).toBe(`list = {\n${Array.from({ length: 26 }, (_, i) => `  ${i + 1},`).join("\n").slice(0, -1)}\n};\n`)
})

test("keeps patterns attached and preserves named-blank adjacency", () => {
  expect(formatWolfram("f[x_]:=x+1")).toBe("f[x_] := x + 1\n")
  expect(formatWolfram("{a_,b__,c___,d_.};")).toBe("{a_, b__, c___, d_.};\n")
  expect(formatWolfram("a_ b")).toBe("a_ b\n")
})

test("compound tokens stay glued", () => {
  expect(formatWolfram("x[[1;;3]]")).toBe("x[[1;;3]]\n")
  expect(formatWolfram('msg::"text";f\'[x];')).toBe('msg::"text";\nf\'[x];\n')
  expect(formatWolfram("x!+y;n!!;!flag;")).toBe("x! + y;\nn!!;\n!flag;\n")
  expect(formatWolfram("f=(#^2)&/@{1,2,3};g={#1,#2}&;")).toBe("f = (# ^ 2)& /@ {1, 2, 3};\ng = {#1, #2}&;\n")
})

test("association brackets break like lists", () => {
  const source = `cfg=${A}"a"->1,"bb"->22,"ccc"->333,"dddd"->4444,"eeeee"->55555,"ffffff"->666666${Z};`
  expect(formatWolfram(source)).toBe(
    `cfg = ${A}\n  "a" -> 1,\n  "bb" -> 22,\n  "ccc" -> 333,\n  "dddd" -> 4444,\n  "eeeee" -> 55555,\n  "ffffff" -> 666666\n${Z};\n`,
  )
})

test("long call heads wrap their arguments", () => {
  expect(
    formatWolfram("VeryLongFunctionName[argumentNumberOne,argumentNumberTwo,argumentNumberThree,argumentFour]"),
  ).toBe(
    "VeryLongFunctionName[\n  argumentNumberOne,\n  argumentNumberTwo,\n  argumentNumberThree,\n  argumentFour\n]\n",
  )
})

test("preserves original newlines and collapses blank runs", () => {
  expect(formatWolfram("a=1\n\n\n\nb=2")).toBe("a = 1\n\nb = 2\n")
  expect(formatWolfram("{\n\na,\n\nb\n\n}")).toBe("{\n\n  a,\n\n  b\n\n}\n")
})

test("keeps comments and strings verbatim", () => {
  expect(formatWolfram('s="a;b{}  x";')).toBe('s = "a;b{}  x";\n')
  expect(formatWolfram("x=1(*inline*);")).toBe("x = 1 (*inline*);\n")
})

test("unary minus stays tight", () => {
  expect(formatWolfram("a=-1;b=-c;d=-(e+f);{x,-y,+z};")).toBe("a = -1;\nb = -c;\nd = -(e + f);\n{x, -y, +z};\n")
})

test("shebang survives verbatim", () => {
  expect(formatWolfram("#!/usr/bin/env wolframscript\nx=1;")).toBe("#!/usr/bin/env wolframscript\nx = 1;\n")
})

test("formatting is idempotent", () => {
  const source = `myFunc[arg_]:=Module[{local1,local2=5},local1=arg+local2;If[local1>10,local1*2,{a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s}]]`
  const once = formatWolfram(source)
  expect(formatWolfram(once)).toBe(once)
})

test("bracket propagation keeps closes aligned", () => {
  const source = `emit[${A}"type"->"paused","id"->id,"line"->line,"variables"->snapshotVars[],"extra"->"padding-here"${Z}];`
  const once = formatWolfram(source)
  expect(once).toContain(`emit[${A}\n`)
  expect(once).toContain(`\n${Z}\n];`)
  expect(formatWolfram(once)).toBe(once)
})
