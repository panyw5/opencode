import type { ExtensionHost } from "@opencode-ai/extension-kit/server"

export const fixture = `(* Content-type: application/vnd.wolfram.mathematica *)
(*CacheID: 234*)
Notebook[{
Cell["A notebook", "Title", CellID -> 9],
Cell[CellGroupData[{
Cell[BoxData[RowBox[{"a", "=", "6"}]], "Input", CellLabel -> "In[1]:="],
Cell[BoxData["6"], "Output"]
}, Open]],
Cell[BoxData["a * 7"], "Input"],
Cell[BoxData[FractionBox["1", "2"]], "Input"],
Cell[TextData[{"rich ", StyleBox["text", Bold]}], "Text"]
}, WindowSize -> {800, 600}, TaggingRules -> <|"hello" -> "world"|>]
(* Internal cache information *)`

export function host(settings: Record<string, unknown> = {}): ExtensionHost {
  return {
    id: "local.mathematica-notebook",
    version: "1",
    dataDir: "/tmp",
    cacheDir: "/tmp",
    serverUrl: new URL("http://localhost"),
    settings: { get: () => settings, onDidChange: () => () => {} },
    emit: (name, data) => console.info(`[notebook-test] ${name} ${JSON.stringify(data).slice(0, 250)}`),
    log: Object.fromEntries(
      ["debug", "info", "warn", "error"].map((level) => [
        level,
        (message: string, extra: unknown) =>
          console.info(`[notebook-test] ${level} ${message} ${JSON.stringify(extra ?? {})}`),
      ]),
    ) as ExtensionHost["log"],
  }
}
