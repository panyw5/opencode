import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { withCdp } from "./cdp"

// Run against the already-running development Electron renderer on :9222.
const directory = await mkdtemp("/private/tmp/opencode-home-path-")
const field = '[data-component="home-path-input"] input'

try {
  await mkdir(`${directory}/parent/child/empty`, { recursive: true })
  await mkdir(`${directory}/parent/sibling`)
  await withCdp(async (cdp, target) => {
    assert.ok(target.url.includes("localhost:5173"), "Only test the development renderer")
    async function wait(expression: string) {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (await cdp.evaluate<boolean>(expression)) return
        await Bun.sleep(50)
      }
      throw new Error(`Timed out: ${expression}`)
    }
    async function click(selector: string) {
      const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        node.scrollIntoView({ block: "nearest" });
        const rect = node.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`)
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
    }
    await click('[data-action="home-open"]')
    await wait(`!!document.querySelector(${JSON.stringify(field)})`)
    const original = await cdp.evaluate<string>(`document.querySelector(${JSON.stringify(field)}).value`)
    const href = await cdp.evaluate<string>("location.href")
    try {
      await cdp.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(field)});
        input.focus(); input.select();
      })()`)
      await cdp.call("Input.insertText", { text: `${directory}/` })
      await wait('document.querySelector("#home-path-options [role=option] span")?.textContent === "parent"')
      for (const [name, children] of [
        ["parent", ["child", "sibling"]],
        ["child", ["empty"]],
        ["empty", []],
      ] as const) {
        await click("#home-path-option-0")
        const expected = `${directory}/parent/${name === "parent" ? "" : name === "child" ? "child/" : "child/empty/"}`
        await wait(
          `JSON.stringify([...document.querySelectorAll("#home-path-options [role=option] .font-mono")].map(n => n.textContent)) === ${JSON.stringify(JSON.stringify(children))}`,
        )
        const state = await cdp.evaluate<{
          query: string
          focused: boolean
          expanded: string
          cursor: number
        }>(`(() => {
          const input = document.querySelector(${JSON.stringify(field)});
          return { query: input.value, focused: document.activeElement === input,
            expanded: input.getAttribute("aria-expanded"), cursor: input.selectionStart };
        })()`)
        assert.equal(await cdp.evaluate("location.href"), href, "Click must not open the project")
        assert.equal(state.query, expected)
        assert.equal(state.focused, true)
        assert.equal(state.expanded, "true")
        assert.equal(state.cursor, expected.length)
        console.log(`[home-path-qa] completed=${name} children=${children.join(",")} focus=input route=unchanged`)
        if (name === "parent") {
          await cdp.call("Input.insertText", { text: "ch" })
          await wait('document.querySelectorAll("#home-path-options [role=option]").length === 1')
          assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(field)}).value`), `${expected}ch`)
          console.log("[home-path-qa] continued typing filters child directories")
        }
      }
      console.log(
        "[home-path-qa] PASS nested clicks, empty directory, trailing slash, focus, caret and continued input",
      )
    } finally {
      await cdp.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(field)});
        if (!input) return;
        input.value = ${JSON.stringify(original)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        input.blur();
      })()`)
    }
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
