import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { editNotebook, NotebookParseError, parseNotebook } from "../src/notebook"

const printedOutput = `Notebook[{
Cell[BoxData[InterpretationBox["result",
  StringForm["result", (Rational[1, 2] c) One,
    Derivative[1][T], f[x] g[y], f[x][[1]], {a, b}[[2]]],
  Editable -> False]], "Output"],
Cell["heading" (* keep this comment *), "Section"],
Cell[BoxData[RowBox[{"x", "+", "1"}]], "Input"],
Cell[BoxData[InterpretationBox["data", <|"a" -> f[x][y], "b" -> {1, 2}|>]], "Output"]
}, TaggingRules -> <|"a" -> {1, 2}, "b" -> f[x][y]|>]`

test("Mathematica output supports curried heads, implicit products, Part and associations", () => {
  const notebook = parseNotebook(printedOutput)
  expect(notebook.cells).toHaveLength(4)
  expect(notebook.cells[0]).toMatchObject({ style: "Output", editable: false, runnable: false })
  expect(notebook.cells[1]).toMatchObject({ style: "Section", text: "heading", editable: true })
  expect(notebook.cells[2]).toMatchObject({ style: "Input", text: "x+1", runnable: true })
  expect(editNotebook(printedOutput, [])).toBe(printedOutput)
  const edited = editNotebook(printedOutput, [{ index: 1, text: "updated" }])
  expect(edited).toContain('"updated" (* keep this comment *)')
  expect(parseNotebook(edited).cells[0].raw).toBe(notebook.cells[0].raw)
  expect(parseNotebook(edited).cells[3].raw).toBe(notebook.cells[3].raw)
})

test("opaque compound expressions are preserved instead of parsed as a single call", () => {
  for (const value of ["f[x][y]", "f[x] g[y]", "{a, b}[[1]]", "f[x] + g[y]", 'f["[\\\"x\\\"]"][[1]]']) {
    const source = `Notebook[{Cell[BoxData[InterpretationBox["preview", ${value}]], "Output"]}]`
    const notebook = parseNotebook(source)
    expect(notebook.cells).toHaveLength(1)
    expect(notebook.cells[0].raw).toContain(value)
    expect(notebook.cells[0].editable).toBe(false)
  }
})

test("genuinely unbalanced notebook delimiters report their source position", () => {
  try {
    parseNotebook('Notebook[{\nCell[BoxData["x"}, "Input"]}]')
    throw new Error("Expected parser failure")
  } catch (error) {
    expect(error).toBeInstanceOf(NotebookParseError)
    expect((error as NotebookParseError).line).toBe(2)
    expect((error as NotebookParseError).column).toBeGreaterThan(1)
  }
})

test("RowBox newline tokens become real cell line breaks, not literal escape text", () => {
  const source = String.raw`Notebook[{Cell[BoxData[RowBox[{"(* comment *)", "\[IndentingNewLine]", "21*2"}]], "Input"]}]`
  expect(parseNotebook(source).cells[0].text).toBe("(* comment *)\n21*2")
  const literal = String.raw`Notebook[{Cell[BoxData[RowBox[{"\"\[IndentingNewLine]\""}]], "Input"]}]`
  expect(parseNotebook(literal).cells[0].text).toBe('"\\[IndentingNewLine]"')
})

test("large cached output strings do not interfere with following cells", () => {
  const data = "a".repeat(2_000_000)
  const source = `Notebook[{Cell[BoxData[InterpretationBox["output", f[CompressedData["${data}"]][x]]], "Output"], Cell[BoxData["2+2"], "Input"]}]`
  expect(parseNotebook(source).cells[1].text).toBe("2+2")
  expect(editNotebook(source, [])).toBe(source)
})

test("large opaque structures are validated but not recursively materialized", () => {
  const data = Array(111111).fill('f["opaque-value"]').join(",")
  const output = `Cell[BoxData[UnknownBox[{${data}}]], "Output"]`
  const source = `(* prefix *) Notebook[{${output}, Cell["tail", "Text"]}, TaggingRules -> <|"data" -> {${data}}|>] (* cache *)`
  const notebook = parseNotebook(source)
  expect(notebook.cells).toHaveLength(2)
  expect(notebook.cells[0]).toMatchObject({ editable: false, runnable: false, raw: output })
  expect(notebook.cells[1].text).toBe("tail")
  expect(editNotebook(source, [], undefined, notebook)).toBe(source)
  expect(editNotebook(source, [{ index: 1, text: "changed" }], undefined, notebook)).toBe(
    source.replace('Cell["tail", "Text"]', 'Cell["changed", "Text"]'),
  )
})

test("deep unknown boxes and unused options do not consume the text AST depth budget", () => {
  const opaque = `${"f[".repeat(512)}"hidden"${"]".repeat(512)}`
  const source = `Notebook[{
    Cell[CellGroupData[{
      Cell[BoxData[UnknownBox[${opaque}]], "Output", Metadata -> ${opaque}],
      Cell[BoxData[RowBox[{"x", "+", "1"}, Metadata -> ${opaque}], Metadata -> ${opaque}], "Input", Metadata -> ${opaque}],
      Cell[TextData[{"rich ", StyleBox["text", Metadata -> ${opaque}], FormBox["!", ${opaque}]}], "Text"]
    }, ${opaque}]]
  }, Metadata -> ${opaque}]`
  const notebook = parseNotebook(source)
  expect(notebook.cells.map(({ text, editable, runnable }) => ({ text, editable, runnable }))).toEqual([
    { text: `BoxData[UnknownBox[${opaque}]]`, editable: false, runnable: false },
    { text: "x+1", editable: true, runnable: true },
    { text: "rich text!", editable: false, runnable: false },
  ])
  expect(editNotebook(source, [])).toBe(source)
  const edited = editNotebook(source, [{ index: 1, text: "2+2" }], undefined, notebook)
  expect(parseNotebook(edited).cells[0].raw).toBe(notebook.cells[0].raw)
  expect(parseNotebook(edited).cells[2].raw).toBe(notebook.cells[2].raw)
})

test("many unsorted edits and an append preserve all untouched bytes", () => {
  const count = 10000
  const prefix = "(* prefix (* nested *) *) Notebook[{\n"
  const suffix = '\n}, Metadata -> <|"keep" -> f[x][y]|>] (* cache *)'
  const cell = (index: number, text: string) =>
    `Cell[BoxData["${text}"], "Input", CellID -> ${index}, CellLabel -> "unchanged"]`
  const source = prefix + Array.from({ length: count }, (_, index) => cell(index, `x${index}`)).join(",\n") + suffix
  const notebook = parseNotebook(source)
  const edits = Array.from({ length: count }, (_, index) => ({ index, text: `new${index}` })).reverse()
  const append = { style: "Text" as const, text: "appended" }
  const expected =
    prefix +
    Array.from({ length: count }, (_, index) => cell(index, `new${index}`)).join(",\n") +
    '\n,\nCell["appended", "Text"]\n' +
    suffix.slice(1)
  expect(notebook.cells).toHaveLength(count)
  expect(editNotebook(source, [], undefined, notebook)).toBe(source)
  expect(editNotebook(source, edits, append, notebook)).toBe(expected)
  expect(editNotebook(source, edits, append)).toBe(expected)
  const next = parseNotebook(expected)
  expect(next.cells).toHaveLength(count + 1)
  expect(next.cells[0].text).toBe("new0")
  expect(next.cells[count - 1].text).toBe(`new${count - 1}`)
  expect(next.cells[count].text).toBe("appended")
})

test("skipped boxes and unused options still report exact delimiter positions", () => {
  const wrappers = [
    ["Notebook[{Cell[BoxData[UnknownBox[", ']], "Output"]}]'],
    ['Notebook[{Cell["ok", "Text", Metadata -> ', "]}]"],
    ['Notebook[{Cell[BoxData[RowBox[{"x"}, Metadata -> ', ']], "Input"]}]'],
    ['Notebook[{Cell[TextData["x", Metadata -> ', '], "Text"]}]'],
    ['Notebook[{Cell[CellGroupData[{Cell["x"]}, ', "]]}]"],
    ["Notebook[{}, Metadata -> ", "]"],
  ]
  for (const [prefix, suffix] of wrappers) {
    const source = `${prefix}f[\n    }${suffix}`
    const offset = prefix.length + "f[\n    ".length
    try {
      parseNotebook(source)
      throw new Error("Expected parser failure")
    } catch (error) {
      expect(error).toBeInstanceOf(NotebookParseError)
      expect(error).toMatchObject({ offset, line: 2, column: 5 })
    }
  }
  for (const source of [
    'Notebook[{}, Metadata -> f["unterminated]]',
    'Notebook[{Cell[BoxData[UnknownBox[(* unterminated]]], "Output"]}]',
    'Notebook[{}, Metadata -> <|"a" -> {1, 2]|>]',
    'Notebook[{Cell["ok", "Text"]}] ; Run["never"]',
  ])
    expect(() => parseNotebook(source)).toThrow()
})

test.skipIf(!process.env.MATHEMATICA_NOTEBOOK_FIXTURE)(
  "external real notebook parses and round-trips without rewriting outputs",
  async () => {
    const source = await readFile(process.env.MATHEMATICA_NOTEBOOK_FIXTURE!, "utf8")
    const started = performance.now()
    const notebook = parseNotebook(source)
    console.info(
      `[notebook-regression] cells=${notebook.cells.length} parseMs=${Math.round(performance.now() - started)}`,
    )
    expect(notebook.cells.length).toBeGreaterThan(0)
    expect(editNotebook(source, [])).toBe(source)
    const cell =
      notebook.cells.find((cell) => cell.editable && cell.style === "Title") ??
      notebook.cells.find((cell) => cell.editable)!
    const edited = editNotebook(source, [{ index: cell.index, text: cell.text + " regression" }])
    const next = parseNotebook(edited)
    expect(next.cells.length).toBe(notebook.cells.length)
    for (const original of notebook.cells) {
      if (original.index !== cell.index) expect(next.cells[original.index].raw).toBe(original.raw)
    }
  },
)
