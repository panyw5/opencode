import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

// Mount the real tool card without changing the user's sessions or todos.
await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const ui = `/@fs${resolve(import.meta.dir, "../../ui/src")}`
  try {
    await cdp.evaluate(`(async () => {
      const resources = performance.getEntriesByType("resource").map(item => item.name);
      const { render } = await import(resources.find(url => url.includes("/solid-js_web.js")));
      const { createStore } = await import(resources.find(url => url.includes("/solid-js_store.js")));
      const { DataProvider } = await import(${JSON.stringify(`${ui}/context/data.tsx`)});
      const { getTool } = await import(${JSON.stringify(`${ui}/components/message-part.tsx`)});
      const Tool = getTool("todowrite");
      const todos = Array.from({ length: 9 }, (_, index) => ({
        content: "Task " + index, status: "pending", priority: "medium",
      }));
      const [state, setState] = createStore({ initial: true, current: todos });
      const before = {
        type: "tool", tool: "todowrite", id: "todo-before", messageID: "before", sessionID: "fixture",
        state: { status: "completed", input: { todos }, metadata: { todos }, output: "", time: { start: 1, end: 2 } },
      };
      const part = {
        ...before, id: "todo-current", messageID: "current",
      };
      const data = {
        session: [], session_status: {}, session_diff: {},
        get message() { return { fixture: state.initial ? [{ id: "current" }] : [{ id: "before" }, { id: "current" }] }; },
        part: { before: [before], current: [part] },
      };
      const host = document.createElement("div");
      host.id = "message-todo-snapshot-regression";
      host.style.cssText = "position:fixed;left:32px;top:100px;width:680px;z-index:10000;padding:24px;background:var(--background-base);border:1px solid var(--border-base)";
      document.body.append(host);
      const dispose = render(() => DataProvider({
        data, directory: "/tmp",
        get children() { return Tool({
          tool: "todowrite", part, input: {}, status: "completed",
          get metadata() { return { todos: state.current }; },
        }); },
      }), host);
      window.__todoSnapshotRegression = {
        update(indices) {
          setState({ initial: false, current: todos.map((todo, index) => ({
            ...todo, status: indices.includes(index) ? "completed" : "pending",
          })) });
        },
        cleanup() { dispose(); host.remove(); },
      };
    })()`)
    console.log("[todo-snapshot-test] mounted real todowrite card with full initial list")

    const snapshot = () =>
      cdp.evaluate<{
        rows: string[]
        sequence: string[]
        gaps: { text: string; height: number; x: number }[]
        x: number
      }>(`(() => {
        const host = document.getElementById("message-todo-snapshot-regression");
        const list = host.querySelector("[data-component=todos]");
        return {
          rows: [...host.querySelectorAll("[data-slot=message-part-todo-content]")].map(row => row.textContent),
          sequence: [...list.children].map(row => row.textContent),
          gaps: [...host.querySelectorAll("[data-slot=message-part-todo-gap]")].map(gap => ({
            text: gap.textContent, height: gap.getBoundingClientRect().height, x: gap.getBoundingClientRect().x,
          })),
          x: host.querySelector("[data-component=checkbox]").getBoundingClientRect().x,
        };
      })()`)
    const initial = await snapshot()
    assert.equal(initial.rows.length, 9)
    assert.equal(initial.gaps.length, 0)

    const cases = [
      { name: "first changes", changes: [0, 1], expected: ["Task 0", "Task 1", "Task 2", "\u22ee"] },
      { name: "middle change", changes: [4], expected: ["\u22ee", "Task 3", "Task 4", "Task 5", "\u22ee"] },
      { name: "last change", changes: [8], expected: ["\u22ee", "Task 7", "Task 8"] },
      {
        name: "distant changes",
        changes: [1, 7],
        expected: ["Task 0", "Task 1", "Task 2", "\u22ee", "Task 6", "Task 7", "Task 8"],
      },
    ]
    for (const item of cases) {
      await cdp.evaluate(`window.__todoSnapshotRegression.update(${JSON.stringify(item.changes)})`)
      const result = await snapshot()
      assert.deepEqual(result.sequence, item.expected)
      assert.ok(result.gaps.every((gap) => gap.text === "\u22ee" && gap.height === 16 && gap.x === result.x))
      console.log(
        `[todo-snapshot-test] verified ${item.name}; rows=${result.rows.length} vertical-gaps=${result.gaps.length}`,
      )
    }

    await cdp.evaluate(`window.__todoSnapshotRegression.update([4]);
      document.getElementById("message-todo-snapshot-regression").style.width = "340px";`)
    const narrow = await cdp.evaluate<boolean>(`(() => {
      const host = document.getElementById("message-todo-snapshot-regression");
      return host.scrollWidth <= host.clientWidth;
    })()`)
    assert.equal(narrow, true, "compact card fits a narrow panel")
    const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write("/tmp/opencode-message-todo-snapshot.png", Buffer.from(shot.data, "base64"))
    console.log("[todo-snapshot-test] PASS narrow layout; screenshot=/tmp/opencode-message-todo-snapshot.png")
  } finally {
    await cdp.evaluate("window.__todoSnapshotRegression?.cleanup(); delete window.__todoSnapshotRegression")
    console.log("[todo-snapshot-test] fixture removed; existing session data untouched")
  }
})
