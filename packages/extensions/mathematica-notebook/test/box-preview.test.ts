import { describe, expect, test } from "bun:test"
import { namedCharacters, previewBoxes } from "../src/box-preview"
import { PREVIEW_LIMITS as L } from "../src/preview-protocol"

describe("bounded non-evaluating box previews", () => {
  test("fraction/script arguments and grid columns remain distinct", () => {
    const result = previewBoxes('BoxData[RowBox[{"a", "+", FractionBox["1", SuperscriptBox["x", "2"]]}]]')
    expect(result.status).toBe("complete")
    expect(result.box.children).toEqual([
      { kind: "text", text: "a+" },
      {
        kind: "frac",
        children: [
          { kind: "text", text: "1" },
          {
            kind: "sup",
            children: [
              { kind: "text", text: "x" },
              { kind: "text", text: "2" },
            ],
          },
        ],
      },
    ])
    const grid = previewBoxes('GridBox[{{"a", "b"}, {"c", "d"}}]')
    expect(grid.box.children?.map((row) => row.children?.length)).toEqual([2, 2])
  })
  test("all basic layouts, wrappers and inline cells are static", () => {
    for (const box of [
      'SubscriptBox["x","1"]',
      'SubsuperscriptBox["x","1","2"]',
      'SqrtBox["x"]',
      'RadicalBox["x","3"]',
      'OverscriptBox["x","."]',
      'UnderscriptBox["x","1"]',
      'UnderoverscriptBox["x","1","2"]',
      'TextData[{"hi",Cell[BoxData[FractionBox["1","2"]],"InlineFormula"]}]',
    ])
      expect(previewBoxes(box).status).toBe("complete")
    const styled = previewBoxes('StyleBox["x", Bold, FontSlant -> "Italic", FontSize -> 9999, Callback :> Run["bad"]]')
    expect(styled.box.style).toEqual({ bold: true, italic: true, size: 40 })
    expect(previewBoxes('BoxData[{RowBox[{"a","=","1"}],"\\[IndentingNewLine]",FractionBox["1","2"]}]').status).toBe(
      "complete",
    )
  })
  test("interpretations and callbacks never visit hidden data", () => {
    const result = previewBoxes(`InterpretationBox[FractionBox["1","2"], Run["${"z".repeat(2_000_000)}"]]`)
    expect(result.status).toBe("complete")
    expect(result.nodes).toBe(4)
    expect(JSON.stringify(result).length).toBeLessThan(500)
    expect(previewBoxes('ButtonBox["safe", ButtonFunction :> Run["bad"]]').box).toEqual({ kind: "text", text: "safe" })
  })
  test("unknown children stay visible instead of silently disappearing", () => {
    const result = previewBoxes('RowBox[{"a", UnknownBox["secret"], "b"}]')
    expect(result.status).toBe("partial")
    expect(result.box.children?.[1]).toEqual({ kind: "unknown", text: "UnknownBox" })
    expect(JSON.stringify(result)).not.toContain("secret")
  })
  test("named Greek and script characters use their display characters", () => {
    expect(namedCharacters("\\[Alpha] \\[CapitalAlpha] \\[Eta] \\[ScriptB] \\[DoubleStruckCapitalR]")).toBe(
      "\u03b1 \u0391 \u03b7 \u{1d4b7} \u211d",
    )
    expect(namedCharacters("\\[UnknownCharacter]")).toBe("\\[UnknownCharacter]")
  })
  test("shortened output is structural and does not use line/session/expr fields", () => {
    const result = previewBoxes(
      'TemplateBox[<|"shortenedBoxes" -> TagBox[RowBox[{"x", TemplateBox[{"4"}, "OutputSizeLimit`Skeleton"]}], Short[#,8]&], "line" -> 2, "expr" -> Run["bad"]|>, "OutputSizeLimitTemplate"]',
    )
    expect(result.status).toBe("limited")
    expect(result.box.children?.[0]?.text).toBe("x<<4>>")
    expect(JSON.stringify(result)).not.toContain("bad")
  })
  test("unknown template display functions remain opaque", () => {
    const result = previewBoxes('TemplateBox[{"x"}, "custom", DisplayFunction -> (Run["bad"]&)]')
    expect(result.status).toBe("unsupported")
    expect(result.reasons).toEqual(["TemplateBox: custom"])
  })
  test("message templates decode embedded boxes without evaluating them", () => {
    const message = '"Warning \\!\\(\\*FractionBox[\\"1\\",\\"2\\"]\\)"'
    const source = `TemplateBox[{"f", "tag", ${JSON.stringify(message)}}, "MessageTemplate2"]`
    const result = previewBoxes(source)
    expect(result.status).toBe("complete")
    expect(JSON.stringify(result.box)).toContain('"kind":"frac"')
  })
  test("multiline BoxData preserves explicit line breaks in MathML rows", () => {
    const result = previewBoxes('BoxData[{RowBox[{"a","=","1","\\[IndentingNewLine]"}], RowBox[{"b","=","2"}]}]')
    expect(result.box.kind).toBe("lines")
    expect(result.box.children?.map((row) => row.children?.map((item) => item.text).join(""))).toEqual(["a=1", "b=2"])
    const giant = previewBoxes(JSON.stringify("x\n".repeat(3000)))
    expect(giant.status).toBe("limited")
    expect(giant.box.children!.length).toBeLessThanOrEqual(128)
  })
  test("node, depth, grid, text, byte and cancellation limits degrade locally", () => {
    const row = previewBoxes(`RowBox[{${Array.from({ length: 10000 }, () => 'FractionBox["1","2"]').join(",")}}]`)
    expect(row.status).toBe("limited")
    expect(row.nodes).toBeLessThanOrEqual(L.nodes + 4)
    expect(JSON.stringify(row).length * 3).toBeLessThanOrEqual(L.cellBytes)
    expect(previewBoxes(`${"SqrtBox[".repeat(80)}"x"${"]".repeat(80)}`).status).toBe("limited")
    expect(previewBoxes(`GridBox[{${Array.from({ length: 1000 }, () => '{"a","b"}').join(",")}}]`).status).toBe(
      "limited",
    )
    expect(previewBoxes(`"${"a".repeat(100000)}"`).status).toBe("limited")
    expect(previewBoxes('RowBox[{"a","b"}]', 0, () => true).status).toBe("limited")
    expect(previewBoxes('FractionBox["1",').status).toBe("unsupported")
  })
})
