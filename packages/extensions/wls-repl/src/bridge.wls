(* WolframScript debug bridge for the local.wls-repl extension.

   Control channel: the host appends JSON lines (RawJSON objects) to the
   file named by the WLS_REPL_CTL environment variable. Wolfram cannot read
   pipes, FIFOs or sockets from `wolframscript -file` mode, so the bridge
   follows the control file through an external `tail -f` stream, which
   blocks in `Read` until the next appended line arrives.

   Output: protocol messages are single stdout lines of the form
   RS (0x1e) + 8-hex-char nonce + compact JSON. Everything the user code
   prints (Print, kernel messages) flows to stdout untouched; the host
   classifies lines by the RS+nonce prefix only.

   Everything here lives in the WLSBridge` context so bridge-local Module
   and Table symbols can never collide with user variables (they would
   otherwise appear in Global` and trigger shadowing warnings for user
   code parsed in the User` context). General::shdw is disabled outright:
   user code always runs with $ContextPath = {User`, System`} so Global`
   leftovers from wolframscript startup are never consulted, and the
   warning would be pure noise.

   Requests (host -> bridge):
     {"id","op":"ping"}
     {"id","op":"run","code","breakpoints":[line...],"timeoutSeconds"}
     {"id","op":"eval","code","timeoutSeconds"}          (idle REPL)
     {"id","op":"eval","code"}                           (while paused: inspect)
     {"op":"continue" | "step" | "abort"}                (while paused)
     {"op":"shutdown"}

   Breakpoints are statement-granular: a statement stops when a breakpoint
   line falls inside (previous executed statement end, this statement end]. *)

Begin["WLSBridge`"];

Off[General::shdw];

wlsCtlPath = Environment["WLS_REPL_CTL"];
If[!StringQ[wlsCtlPath] || wlsCtlPath === "",
  Print["wls-repl bridge: WLS_REPL_CTL is not set"]; Quit[1]];

wlsNonce = IntegerString[RandomInteger[{2^31, 2^32 - 1}], 16, 8];
wlsTimeoutMarker = "$$wls-repl-timeout$$";

wlsCtl = OpenRead["!tail -n +1 -f " <> wlsCtlPath];
If[Head[wlsCtl] =!= InputStream,
  Print["wls-repl bridge: cannot follow control file: " <> ToString[wlsCtl]]; Quit[1]];

(* Raw newlines and tabs never appear inside JSON string values (they are
   escaped), so stripping them compacts ExportString output safely. *)
emit[assoc_Association] := Print["\:001e" <> wlsNonce <>
  StringReplace[ExportString[assoc, "JSON"], {"\n" -> "", "\t" -> ""}]];

readCmd[] := Module[{line},
  line = Read[wlsCtl, String];
  If[line === EndOfFile,
    emit[<|"type" -> "bridge-error", "text" -> "control channel closed"|>]; Quit[]];
  Quiet@Check[ImportString[line, "RawJSON"], $Failed]];

timeoutOf[cmd_] := Module[{seconds = Lookup[cmd, "timeoutSeconds", 60.]},
  If[!NumberQ[seconds] || seconds <= 0, seconds = 60.]; seconds];

breakpointsOf[cmd_] := Module[{lines = Lookup[cmd, "breakpoints", {}]},
  If[ListQ[lines], Select[lines, IntegerQ], {}]];

(* Definition text for one symbol, by full context-qualified name. The
   symbol must be wrapped via ToExpression[..., HoldComplete] and released
   through a RuleDelayed pattern so it reaches the held OwnValues/DownValues
   calls unevaluated; With or Evaluate would first apply the symbol's own
   value (a = 42 would degrade to OwnValues[42]). *)
symDefText[name_String] := Module[{held, parts},
  held = Quiet@Check[ToExpression[name, InputForm, HoldComplete], HoldComplete[$Failed]];
  parts = Quiet@Check[
    held /. HoldComplete[s_Symbol] :> Join[OwnValues[s], DownValues[s], SubValues[s], UpValues[s]], {}];
  StringRiffle[Function[p, ToString[InputForm[p]]] /@ parts, "; "]];

snapshotVars[] := Module[{names = Take[Names["User`*"], UpTo[200]]},
  Association @ Table[
    With[{full = names[[i]], short = Last[StringSplit[names[[i]], "`"]]},
      short -> StringTake[symDefText[full], UpTo[400]]],
    {i, Length[names]}]];

(* Evaluate one expression in the isolated User` context. Messages print
   to stdout (console) as they occur; only the result text is returned. *)
evalUser[code_, timeout_] := Module[{value},
  value = Block[{$Context = "User`", $ContextPath = {"User`", "System`"}},
    TimeConstrained[ToExpression[code], timeout, wlsTimeoutMarker]];
  Which[
    value === wlsTimeoutMarker,
      <|"ok" -> False, "text" -> "evaluation timed out"|>,
    value === $Failed || FailureQ[value],
      <|"ok" -> False, "text" -> "syntax error"|>,
    True,
      <|"ok" -> True, "text" -> ToString[InputForm[value]]|>]];

(* Blocking pause loop: emit state, then serve inspect/continue/step/abort
   commands until the user resumes. *)
pauseLoop[id_, line_] := Catch[
  emit[<|"type" -> "paused", "id" -> id, "line" -> line, "variables" -> snapshotVars[]|>];
  While[True,
    With[{cmd = readCmd[]},
      If[AssociationQ[cmd],
        With[{op = Lookup[cmd, "op", ""]},
          Which[
            op === "eval",
              With[{r = evalUser[Lookup[cmd, "code", ""], timeoutOf[cmd]]},
                emit[<|"type" -> "inspect-result", "id" -> Lookup[cmd, "id", ""],
                      "ok" -> r["ok"], "text" -> r["text"]|>]],
            op === "continue", Throw["continue", "wls-pause"],
            op === "step", Throw["step", "wls-pause"],
            op === "abort", Throw["abort", "wls-pause"],
            op === "ping", emit[<|"type" -> "pong", "id" -> Lookup[cmd, "id", ""]|>],
            op === "shutdown", Quit[],
            True, Null]]]]],
  "wls-pause"];

(* Split code into held top-level statements and execute them one by one,
   pausing before any statement whose line interval contains a breakpoint. *)
runOne[id_, code_, breakLines_, timeout_] := Module[
   {stream, pos1, held, src, startLine, endLine, prevEnd = 0, result, cmd,
    stepping = False, aborted = False},
   stream = StringToStream[code];
   Block[{$Context = "User`", $ContextPath = {"User`", "System`"}},
     While[True,
       pos1 = StreamPosition[stream];
       held = Read[stream, HoldComplete[Expression]];
       If[held === EndOfFile, Break[]];
       If[held === $Failed || FailureQ[held],
         emit[<|"type" -> "error", "id" -> id,
               "text" -> "syntax error near character " <> ToString[StreamPosition[stream]]|>];
         aborted = True; Break[]];
       src = StringTake[code, {pos1 + 1, StreamPosition[stream]}];
       If[StringEndsQ[src, "\n"], src = StringDrop[src, -1]];
       startLine = 1 + StringCount[StringTake[code, {1, pos1}], "\n"];
       endLine = startLine + StringCount[src, "\n"];
       If[held === HoldComplete[Null], Continue[]];
       If[stepping || MemberQ[breakLines, _?(# > prevEnd && # <= endLine &)],
         cmd = pauseLoop[id, startLine];
         Which[
           cmd === "abort", aborted = True; Break[],
           cmd === "step", stepping = True,
           True, stepping = False]];
       prevEnd = endLine;
       result = TimeConstrained[ReleaseHold[held], timeout, wlsTimeoutMarker];
       If[result === wlsTimeoutMarker,
         emit[<|"type" -> "error", "id" -> id, "line" -> startLine,
               "text" -> "statement timed out after " <> ToString[timeout] <> "s"|>];
         aborted = True; Break[]];
       If[result =!= Null,
         emit[<|"type" -> "result", "id" -> id, "line" -> startLine,
               "text" -> StringTake[ToString[InputForm[result]], UpTo[2000]]|>]];
       ];
     ];
   Close[stream];
   emit[<|"type" -> "done", "id" -> id, "aborted" -> aborted|>]];

emit[<|"type" -> "ready", "protocol" -> 1, "nonce" -> wlsNonce, "version" -> ToString[$Version]|>];

While[True,
  With[{cmd = readCmd[]},
    If[AssociationQ[cmd],
      With[{op = Lookup[cmd, "op", ""]},
        Which[
          op === "ping", emit[<|"type" -> "pong", "id" -> Lookup[cmd, "id", ""]|>],
          op === "run", runOne[Lookup[cmd, "id", ""], Lookup[cmd, "code", ""],
                               breakpointsOf[cmd], timeoutOf[cmd]],
          op === "eval",
            With[{r = evalUser[Lookup[cmd, "code", ""], timeoutOf[cmd]]},
              emit[<|"type" -> "eval-result", "id" -> Lookup[cmd, "id", ""],
                    "ok" -> r["ok"], "text" -> r["text"]|>]],
          op === "shutdown", Quit[],
          True, Null]]]]];

End[];
