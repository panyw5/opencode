import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

// Run with a populated project-task list open in the dev renderer.
await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const iconPath = `/@fs${resolve(import.meta.dir, "../../ui/src/components/icon.tsx")}`
  const cards = await cdp.evaluate<
    {
      title: string
      chips: string[]
      actions: string[]
      archiveIcon: boolean
      keyboardAccessible: boolean
      overflow: boolean
    }[]
  >(`(async () => {
    const { resolveIcon } = await import(${JSON.stringify(iconPath)});
    return Array.from(document.querySelectorAll("[data-component=project-task-item]"), card => {
      const icon = card.querySelectorAll("button")[1]?.querySelector("[data-component=icon]");
      const expected = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      if (icon) expected.innerHTML = resolveIcon("archive", icon.dataset.iconPack).body;
      return {
    title: card.querySelector(".truncate")?.textContent ?? "",
    chips: Array.from(card.querySelectorAll("span.inline-flex"), chip => chip.textContent.trim()),
    actions: Array.from(card.querySelectorAll("button"), button => button.textContent.trim()),
    archiveIcon: !!icon && icon.querySelector("svg")?.innerHTML === expected.innerHTML,
    keyboardAccessible: card.getAttribute("role") === "button" && card.tabIndex === 0,
    overflow: card.scrollWidth > card.clientWidth
  }});
  })()`)
  assert.ok(cards.length > 0, "a populated project-task list must be open")
  for (const card of cards) {
    assert.ok(card.chips.length <= 1, "status and todo-progress chips must be absent")
    for (const chip of card.chips) assert.match(chip, /^\d+ (个会话|sessions?)$/)
    assert.equal(card.actions.length, 2, "new-session and archive actions must remain")
    assert.match(card.actions[0]!, /新建任务会话|New task session/)
    assert.match(card.actions[1]!, /归档|Archive/)
    assert.ok(card.archiveIcon, "archive action must use the archive-box icon")
    assert.ok(card.keyboardAccessible)
    assert.equal(card.overflow, false)
    console.log(
      `[project-task-list-test] title=${card.title} chips=${card.chips.join("|") || "none"} actions=${card.actions.join("|")}`,
    )
  }
  console.log(`[project-task-list-test] PASS cards=${cards.length} session-count-only actions-preserved`)
})
