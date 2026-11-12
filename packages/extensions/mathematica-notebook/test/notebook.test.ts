import { describe, expect, test } from "bun:test"
import { editNotebook, parseNotebook, quote } from "../src/notebook"
import { fixture } from "./helpers"

describe("non-evaluating notebook model", () => {
  test("reads groups, input, outputs, rich text and preserves unsupported boxes", () => {
    const result = parseNotebook(fixture)
    expect(result.cells.map((cell) => cell.style)).toEqual(["Title", "Input", "Output", "Input", "Input", "Text"])
    expect(result.cells[1]).toMatchObject({ text: "a=6", editable: true, runnable: true })
    expect(result.cells[4]).toMatchObject({ editable: false, runnable: true })
    expect(result.cells[5]).toMatchObject({ text: "rich text", editable: false })
  })
  test("edits content only, preserving options, groups and opaque boxes", () => {
    const next = editNotebook(fixture, [
      { index: 1, text: "a = 12" },
      { index: 0, text: "New title" },
    ])
    expect(next).toContain('Cell[BoxData["a = 12"], "Input", CellLabel -> "In[1]:="]')
    expect(next).toContain('Cell["New title", "Title", CellID -> 9]')
    expect(next).toContain('FractionBox["1", "2"]')
    expect(next).toContain('TaggingRules -> <|"hello" -> "world"|>')
    expect(parseNotebook(next).cells).toHaveLength(6)
    expect(editNotebook(fixture, [])).toBe(fixture)
  })
  test("appends cells in empty and grouped notebooks", () => {
    for (const source of [fixture, "Notebook[{}]"]) {
      const next = editNotebook(source, [], { style: "Input", text: 'Print["hello"];\n2+2' })
      const cells = parseNotebook(next).cells
      expect(cells.at(-1)?.text).toBe('Print["hello"];\n2+2')
    }
  })
  test("handles nested comments, escaped strings, Unicode and delimiters in strings", () => {
    const text = 'Print["a,b[]{}"];\n\\[Alpha] + "中文"'
    expect(parseNotebook(`(* (* nested *) *) Notebook[{Cell[BoxData[${quote(text)}], "Input"]}]`).cells[0].text).toBe(
      text,
    )
    expect(parseNotebook('Notebook[{Cell["\\:03b1", "Text"]}]').cells[0].text).toBe("α")
  })
  test("rejects malformed sources, executable tails, duplicate and unsupported edits", () => {
    for (const source of [
      'Notebook[{Cell["oops, "Text"]}]',
      "Notebook[{]",
      'Notebook[{}]; Run["bad"]',
      "(* never ends",
      "x = Notebook[{}]",
    ])
      expect(() => parseNotebook(source)).toThrow()
    expect(() => editNotebook(fixture, [{ index: 5, text: "1/2" }])).toThrow()
    expect(() => editNotebook(fixture, [{ index: 2, text: "1/2" }])).toThrow()
    expect(() =>
      editNotebook(fixture, [
        { index: 0, text: "a" },
        { index: 0, text: "b" },
      ]),
    ).toThrow()
    expect(() => editNotebook(fixture, [{ index: 99, text: "x" }])).toThrow()
  })
  test("rich and mixed boxes retain partial text, stay runnable and patch verbatim", () => {
    const cases = [
      ['TextData[{"hello ", StyleBox["styled", Bold], UnknownBox["hidden"], "!"}]', "hello styled!"],
      ['StyleBox[RowBox[{"x", "+", UnknownBox["hidden"], "1"}], Bold]', "x+1"],
      ['FormBox[RowBox[{"a", "=", "2"}], TraditionalForm]', "a=2"],
      ['RowBox[{"prefix", UnknownBox[RowBox[{"hidden"}]], "suffix"}]', "prefixsuffix"],
      ['TextData["plain"]', "plain"],
      ["RowBox[{}]", ""],
    ] as const
    for (const [box, text] of cases) {
      const source = `Notebook[{Cell[BoxData[${box}], "Input"]}]`
      const notebook = parseNotebook(source)
      expect(notebook.cells[0]).toMatchObject({ text, editable: box === "RowBox[{}]", runnable: true })
      expect(editNotebook(source, [], undefined, notebook)).toBe(source)
      // Non-editable input patches the content expression verbatim.
      if (box !== "RowBox[{}]")
        expect(editNotebook(source, [{ index: 0, text: 'BoxData["z"]' }])).toContain('Cell[BoxData["z"], "Input"]')
    }
    const unknown = 'UnknownBox[TextData[{"not visible"}]]'
    expect(parseNotebook(`Notebook[{Cell[${unknown}, "Text"]}]`).cells[0]).toMatchObject({
      text: unknown,
      editable: false,
      runnable: false,
    })
  })
  test("nested groups preserve ordering, styles, default style and ignored entries", () => {
    const source = `Notebook[{
      Ignored[Cell["not a cell", "Text"]],
      Cell[CellGroupData[{
        Cell["title", "Section"],
        Cell[CellGroupData[{Cell[BoxData["code"], "Code"], Cell["default"]}, Closed]]
      }, Open]],
      Cell["last", "Output"]
    }]`
    expect(
      parseNotebook(source).cells.map(({ text, style, editable, runnable }) => ({ text, style, editable, runnable })),
    ).toEqual([
      { text: "title", style: "Section", editable: true, runnable: false },
      { text: "code", style: "Code", editable: true, runnable: true },
      { text: "default", style: "Text", editable: true, runnable: false },
      { text: "last", style: "Output", editable: false, runnable: false },
    ])
    expect(editNotebook(source, [])).toBe(source)
  })
  test("preparsed edits match the original API for edits, appends and invalid edits", () => {
    for (const source of [fixture, "(* prefix *) Notebook[{(* empty *)}] (* cache *)"]) {
      const notebook = parseNotebook(source)
      const edits = notebook.cells
        .filter((cell) => cell.editable)
        .reverse()
        .map((cell) => ({ index: cell.index, text: `new ${cell.index}\n\"quoted\"` }))
      const append = { style: "Text" as const, text: "appended" }
      expect(editNotebook(source, edits, append, notebook)).toBe(editNotebook(source, edits, append))
      expect(editNotebook(source, [], undefined, notebook)).toBe(source)
      expect(parseNotebook(editNotebook(source, edits, append, notebook)).cells.at(-1)?.text).toBe("appended")
    }
    const notebook = parseNotebook(fixture)
    for (const edits of [
      [{ index: 5, text: "unsafe" }],
      [{ index: 2, text: "unsafe" }],
      [{ index: 99, text: "missing" }],
      [
        { index: 0, text: "first" },
        { index: 0, text: "duplicate" },
      ],
      [{ index: 0, text: undefined as unknown as string }],
    ])
      expect(() => editNotebook(fixture, edits, undefined, notebook)).toThrow(
        "Invalid, duplicate or unsupported cell edit",
      )
  })
  test("opening cells never executes initialization or callbacks", () => {
    expect(
      parseNotebook(
        'Notebook[{Cell[BoxData["Run[\\"bad\\"]"], "Input", InitializationCell -> True]}, NotebookEventActions -> {"WindowOpen" :> Run["bad"]}]',
      ).cells[0].text,
    ).toBe('Run["bad"]')
  })
})
