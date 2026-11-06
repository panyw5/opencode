# Mathematica Notebook

An OpenCode file-viewer extension for textual Mathematica `.nb` notebooks.

- Preview Input, Code, text, headings, existing textual outputs and nested cell groups without starting a kernel or evaluating notebook callbacks.
- Edit supported cells, append Input/Text cells and save back to `.nb`. Unchanged expressions, cell options and group structure are preserved. Conflicting disk changes reject the save and retain your draft.
- Code cells and textual results have lightweight, theme-aware Wolfram syntax coloring. Editing keeps the native textarea, with a scroll-synchronized highlight layer; this is lexical coloring rather than full semantic analysis.
- Run a cell or all supported input cells in document order. A persistent local Wolfram kernel shares variables across cells and agent calls. Print/messages, textual results and PNG graphics appear below the input. Stop/reset kills the kernel and clears its variables.
- Run all, Stop/reset, Save, Reload and Source share a compact host toolbar above the notebook, without a duplicated title or filename. Older hosts fall back to an inline toolbar.
- The `mathematica_notebook` agent tool reads cells and outputs, edits/appends with a revision token, runs cells and stops the shared kernel. Editing and execution use normal agent permission prompts. Graphical tool results include image attachments.

## Build And Install

From the repository root:

```sh
bun install
bun run --cwd packages/extensions/mathematica-notebook build
bun run --cwd packages/opencode src/index.ts extension link "$PWD/packages/extensions/mathematica-notebook"
bun run --cwd packages/opencode src/index.ts extension enable local.mathematica-notebook
```

Enable Mathematica Notebook in Settings > Extensions, then open a `.nb` file. The extension can also be packed using `npm pack --offline` after building and installed as a local `.tgz` through Settings.

Evaluation requires an activated local Wolfram installation and `wolframscript` on PATH, or the `wolframscriptPath` extension setting. Preview/edit/save work without Wolfram. `timeoutSeconds` defaults to 60; `maxKernels` defaults to 2. Set `exposeTool` to `never` to disable agent access.

## Scope

This is a lightweight notebook editor, not an embedded proprietary Mathematica Front End. Plain strings and `RowBox` inputs are editable/executable. Rich text is previewed where possible; unknown boxes (including Dynamic/Manipulate, graphics stored as boxes, templates and typeset fractions) are shown as preserved source and are not executable. Use Source or Mathematica for those cells. Groups are flattened for display, not rewritten on disk. No cell deletion/reordering in this version.

New evaluation outputs are shared in extension memory, not persisted into `.nb`; original output cells remain unchanged and can therefore be stale after rerunning inputs. Closing a viewer leaves its kernel available to agents; Stop/reset, disabling the extension or server shutdown releases kernels. A host crash can leave a kernel behind. Execution has the same filesystem/process privileges as your Wolfram installation, not a sandbox. Only macOS/Unix is currently supported by the control transport (`tail -f`).

## Large Notebooks

Cells use a dynamic-height virtual list, keeping editors and highlighted tokens near the viewport mounted. Focused/composing editors and drafts survive scrolling. Collapsed rich-box source and image expressions are mounted only when expanded. Content over 100,000 characters initially shows a display-only preview; **Load full content** reveals the complete editor/source. Run and Run all always use the complete original text or draft, never the preview.

The notebook declares `content: "self"`, so compatible hosts mount it without fetching source text or computing a Git patch first. Source is loaded only when explicitly selected; file watching still notifies the viewer of external changes. Hosts without this capability retain their normal source-preload behavior.

Syntax coloring falls back to visible plain text above 64 Ki characters. The viewer requests compact cell data without parser source/offset fields. The server reuses parsed results in an 8-entry/64 MiB estimated LRU cache, but still reads and hashes the actual file for every read/run, so external changes and save conflicts remain detectable. Preview still has a 20 MiB file limit and reads the full file; this is not a streaming or paged notebook reader.

With development Electron on CDP 9222, run `bun packages/extensions/mathematica-notebook/test/performance-cdp.ts` from the repository root. It creates disposable 1,000/10,000-cell fixtures and a separate window, reports first-visible time, DOM counts and scroll frame intervals, and verifies focus/composition pinning, draft remounting, resizing, hide/restore and save/reload. `--small` tests only 1,000 cells; `--baseline` records counts without asserting virtual mounting. Timing is diagnostic, not a machine-independent CI threshold.

For read-only verification of a real notebook, run `bun packages/extensions/mathematica-notebook/test/real-file-cdp.ts /absolute/path/file.nb`. It reports parser/transport/viewport/scroll measurements, checks source SHA-256 before and after, and never saves or evaluates cells.

## Tests

```sh
bun run --cwd packages/extensions/mathematica-notebook typecheck
bun run --cwd packages/extensions/mathematica-notebook test
```

With development Electron already running on CDP 9222, `bun packages/extensions/mathematica-notebook/test/style-cdp.ts` from the repository root verifies stylesheet failure/recovery, stale asset URLs, and the full notebook editing/running workflow in a disposable window and fixture.

Real Wolfram integration tests are opt-in: `WOLFRAM_INTEGRATION=1 bun test test/integration.test.ts` from this package. They exercise persistent state, Print, graphics, timeouts, and the agent tool. Backend lifecycle logs include read/save/start/ready/evaluate/stop and kernel stderr, without logging submitted code.
