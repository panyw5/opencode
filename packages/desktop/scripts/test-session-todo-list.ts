import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

// Exercise the real component in the dev renderer without changing session data.
await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const component = `/@fs${resolve(import.meta.dir, "../../app/src/pages/session/composer/session-todo-list.tsx")}`
  try {
    await cdp.evaluate(`(async () => {
      const resources = performance.getEntriesByType("resource").map(item => item.name);
      const { render } = await import(resources.find(url => url.includes("/solid-js_web.js")));
      const { createStore } = await import(resources.find(url => url.includes("/solid-js_store.js")));
      const { TodoList } = await import(${JSON.stringify(component)} + "?t=" + Date.now());
      const host = document.createElement("div");
      host.id = "session-todo-list-regression";
      host.style.cssText = "position:fixed;left:32px;top:100px;width:680px;z-index:10000;padding:24px;background:var(--background-base);border:1px solid var(--border-base)";
      document.body.append(host);
      const [state, setState] = createStore({ circle: true, todos: [
        { content: "Completed task", status: "completed", priority: "medium" },
        { content: "In-progress task", status: "in_progress", priority: "medium" },
        { content: "Pending task", status: "pending", priority: "medium" },
        { content: "Cancelled task", status: "cancelled", priority: "medium" },
      ] });
      const dispose = render(() => TodoList({
        get todos() { return state.todos; },
        get completedAsCircle() { return state.circle; },
        open: true,
      }), host);
      window.__todoListRegression = { setState, cleanup() { dispose(); host.remove(); } };
    })()`)
    console.log("[session-todo-list-test] mounted all four task states")

    const snapshot = () =>
      cdp.evaluate<
        { state: string; children: number; circle: boolean; checkbox: boolean; x: number; width: number }[]
      >(`(() => {
        const host = document.getElementById("session-todo-list-regression");
        return [...host.querySelectorAll("[data-state]")].map(icon => ({
          state: icon.dataset.state,
          children: icon.childElementCount,
          circle: !!icon.querySelector("circle"),
          checkbox: !!icon.querySelector("[data-component=checkbox]"),
          x: icon.nextElementSibling.getBoundingClientRect().x,
          width: icon.getBoundingClientRect().width,
        }));
      })()`)
    let rows = await snapshot()
    assert.deepEqual(
      rows.map((row) => row.state),
      ["completed", "in_progress", "pending", "cancelled"],
    )
    assert.equal(rows[0].children, 1, "completed circle-check remains")
    assert.equal(rows[1].circle, true, "in-progress dot remains")
    assert.equal(rows[2].children, 0, "pending has no checkbox or other status glyph")
    assert.equal(rows[3].checkbox, true, "cancelled presentation is unchanged")
    assert.ok(
      rows.every((row) => row.x === rows[0].x && row.width === 16),
      "text stays aligned",
    )
    console.log("[session-todo-list-test] pending glyph removed; other states and alignment preserved")

    for (const status of ["in_progress", "completed", "pending"]) {
      await cdp.evaluate(`window.__todoListRegression.setState("todos", 2, "status", ${JSON.stringify(status)})`)
      rows = await snapshot()
      assert.equal(rows[2].state, status)
      assert.equal(rows[2].children, status === "pending" ? 0 : 1)
      assert.equal(rows[2].circle, status === "in_progress")
      console.log(`[session-todo-list-test] reactive transition verified status=${status}`)
    }

    await cdp.evaluate('window.__todoListRegression.setState("circle", false)')
    rows = await snapshot()
    assert.equal(rows[0].checkbox, true, "dock completed checkbox remains")
    assert.equal(rows[2].children, 0, "dock pending also has no glyph")
    console.log("[session-todo-list-test] dock and floating-panel modes verified")

    await cdp.evaluate('window.__todoListRegression.setState("circle", true)')
    const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write("/tmp/opencode-session-todo-list.png", Buffer.from(shot.data, "base64"))
    console.log("[session-todo-list-test] PASS screenshot=/tmp/opencode-session-todo-list.png")
  } finally {
    await cdp.evaluate("window.__todoListRegression?.cleanup(); delete window.__todoListRegression")
    console.log("[session-todo-list-test] fixture removed; existing session data untouched")
  }
})
