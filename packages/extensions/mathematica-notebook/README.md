# Mathematica Notebook

An OpenCode file-viewer extension for textual Mathematica `.nb` notebooks.

- Preview Input, Code, text, headings, existing outputs and nested cell groups without starting a kernel or evaluating notebook callbacks. Rich formulas use native MathML for fractions, roots, scripts and grids; visible wrapper contents and selected message/output-size templates are rendered statically.
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

This is a lightweight notebook editor, not an embedded proprietary Mathematica Front End. Plain strings and `RowBox` inputs are editable/executable. Rich preview is independent from editing and execution: rendering a fraction or an `InterpretationBox` never makes it runnable. `BoxData` lists, `TextData`/inline cells, fractions, scripts, roots, over/underscripts, grids, styles and display wrappers are supported. `InterpretationBox` displays only its first argument; hidden interpretations, callbacks and template functions are never evaluated. `MessageTemplate`/`MessageTemplate2` display saved messages and embedded boxes. `OutputSizeLimitTemplate` displays only saved shortened boxes; omitted results from an old kernel session cannot be recovered.

Unknown boxes/templates produce local, explicitly labeled placeholders without hiding supported neighbors. Dynamic/Manipulate, graphics stored as boxes and arbitrary stylesheet templates remain unsupported. The preserved source is fetched only when expanded, in a bounded 16,000-character excerpt; use Source for the complete notebook. Groups are flattened for display, not rewritten on disk. No cell deletion/reordering in this version.

New evaluation outputs are shared in extension memory, not persisted into `.nb`; original output cells remain unchanged and can therefore be stale after rerunning inputs. Closing a viewer leaves its kernel available to agents; Stop/reset, disabling the extension or server shutdown releases kernels. A host crash can leave a kernel behind. Execution has the same filesystem/process privileges as your Wolfram installation, not a sandbox. Only macOS/Unix is currently supported by the control transport (`tail -f`).

## Large Notebooks

Cells use a dynamic-height virtual list, keeping editors and highlighted tokens near the viewport mounted. Focused/composing editors and drafts survive scrolling. Collapsed rich-box source and image expressions are mounted only when expanded. Editable text over 8,000 characters is deferred and initially shows a display-only excerpt; **Load full content** fetches the original text in chunks, up to the 1 MiB inline editor limit. Larger cells remain accessible through Source. Run and Run all always use the complete original text or draft, never an excerpt.

Rich parsing runs in one reusable worker, not the renderer or sidecar event loop. `notebook.open` returns compact summaries; `notebook.cells` batches at most eight requested cells from an immutable revision snapshot, without rereading/hashing the file per formula. Expired snapshots require Reload. Existing `notebook.read/save/run` remain compatible; save/run still validate actual disk contents.

Only rich cells mounted by the virtual list (viewport plus its 400 px buffer) request previews; there is no second per-cell visibility observer. The viewer allows two batches in flight, coalesces duplicate subscribers, cancels offscreen work, rejects stale revisions and mounts completed previews in approximately 4 ms frame slices. Its LRU retains at most 128 previews/8 MiB, not offscreen DOM. Atomic cancellation flags let the worker observe cancellation during traversal. The process-wide worker queue is limited to 16 requests and protected by a 15-second watchdog.

Default rich display budgets are 64 levels, 1,200 visited nodes, approximately 2,000 DOM nodes, 8,000 text characters, 100 ms traversal time and 128 KiB per preview. Grids are limited to 100 rows/32 columns and the same total node budget. Budget exhaustion displays an explicit local truncation marker instead of mounting an unlimited formula. These are display limits, never changes to stored cells. Worker snapshots/render trees share an estimated 48 MiB cache (render trees additionally capped at 4 MiB); the legacy parse cache is capped at 16 MiB. A single oversized active snapshot is retained even if its conservative estimate exceeds the worker cache budget; all other snapshots are evicted. File size remains limited to 20 MiB. In-flight parser memory and temporary serialization are not included in cache estimates.

The notebook declares `content: "self"`, so compatible hosts mount it without fetching source text or computing a Git patch first. Full host source is loaded only when explicitly selected; file watching still notifies the viewer of external changes. Hosts without this capability retain their normal source-preload behavior.

Syntax coloring falls back to visible plain text above 64 Ki characters. Opening a notebook still reads/indexes the complete file in the worker; this is not a streaming file reader. Rich ASTs are built only for requested cells. Backend logs report worker timings, cache bytes/hits and response sizes without formula bodies.

With development Electron on CDP 9222, run `bun packages/extensions/mathematica-notebook/test/performance-cdp.ts` from the repository root. It creates disposable 1,000/10,000-cell fixtures and a separate window, reports first-visible time, DOM counts and scroll frame intervals, and verifies focus/composition pinning, draft remounting, resizing, hide/restore and save/reload. `--small` tests only 1,000 cells; `--baseline` records counts without asserting virtual mounting. Timing is diagnostic, not a machine-independent CI threshold.

For read-only verification of a real notebook, run `bun packages/extensions/mathematica-notebook/test/real-file-cdp.ts /absolute/path/file.nb`. It reports parser/transport/viewport/scroll measurements, checks source SHA-256 before and after, and never saves or evaluates cells.

Run `bun packages/extensions/mathematica-notebook/test/rich-preview-cdp.ts` for 1,000/10,000 formula fixtures and oversized/unknown-box checks (`--small` for 1,000 only). It waits for actual MathML completion, verifies numerator/denominator geometry and namespaces, measures viewport DOM/scroll frames, tests lazy bounded source, and never starts a kernel. Generated fixtures and its separate development window are cleaned up. Screenshot: `/tmp/notebook-rich-preview.png`.

## Tests

```sh
bun run --cwd packages/extensions/mathematica-notebook typecheck
bun run --cwd packages/extensions/mathematica-notebook test
```

With development Electron already running on CDP 9222, `bun packages/extensions/mathematica-notebook/test/style-cdp.ts` from the repository root verifies stylesheet failure/recovery, stale asset URLs, and the full notebook editing/running workflow in a disposable window and fixture.

Real Wolfram integration tests are opt-in: `WOLFRAM_INTEGRATION=1 bun test test/integration.test.ts` from this package. They exercise persistent state, Print, graphics, timeouts, and the agent tool. Backend lifecycle logs include read/save/start/ready/evaluate/stop and kernel stderr, without logging submitted code.
