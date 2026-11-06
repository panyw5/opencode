Begin["OCNotebookBridge`"];
Off[General::shdw];
ctlPath = Environment["WLS_REPL_CTL"];
If[!StringQ[ctlPath], Quit[1]];
nonce = IntegerString[RandomInteger[{2^31, 2^32 - 1}], 16, 8];
ctl = OpenRead["!tail -n +1 -f " <> ctlPath];
emit[data_] := Print["\:001e" <> nonce <>
  StringReplace[ExportString[data, "RawJSON"], {"\n" -> "", "\t" -> ""}]];

evaluate[cmd_] := Module[{logPath, stream, value, printed, image = "", text, ok = True},
  SetDirectory[DirectoryName[cmd["path"]]];
  logPath = CreateTemporary[];
  stream = OpenWrite[logPath, CharacterEncoding -> "UTF-8"];
  value = Block[{$Context = "User`", $ContextPath = {"User`", "System`"},
                 $Output = {stream}, $Messages = {stream}},
    CheckAbort[TimeConstrained[ToExpression[cmd["code"], InputForm],
      Lookup[cmd, "timeoutSeconds", 60], OCNotebookBridge`timeout], $Aborted]];
  Close[stream];
  printed = Quiet[Check[Import[logPath, "Text"], ""]];
  DeleteFile[logPath];
  If[value === timeout || value === $Aborted || value === $Failed || FailureQ[value], ok = False];
  text = Which[value === timeout, "Cell evaluation timed out", value === $Aborted, "Aborted",
    value === Null, "", True, ToString[value, InputForm, PageWidth -> Infinity]];
  If[MatchQ[value, _Graphics | _Graphics3D | _Image],
    image = Quiet[Check[TimeConstrained[ExportString[value, {"Base64", "PNG"}], 10, ""], ""]]];
  emit[<|"type" -> "result", "id" -> cmd["id"], "ok" -> ok,
    "text" -> StringTake[text, UpTo[100000]], "printed" -> StringTake[printed, UpTo[100000]],
    "image" -> If[StringQ[image], StringReplace[image, WhitespaceCharacter -> ""], ""]|>]
];

emit[<|"type" -> "ready"|>];
While[True,
  line = Read[ctl, String];
  If[line === EndOfFile, Break[]];
  command = Quiet[Check[ImportString[line, "RawJSON"], $Failed]];
  If[AssociationQ[command], evaluate[command]]
];
End[];
