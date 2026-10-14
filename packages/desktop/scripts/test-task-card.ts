import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const source = (path: string) => `/@fs${resolve(import.meta.dir, path)}`
  const originalTheme = await cdp.evaluate<string | null>('document.documentElement.getAttribute("data-theme")')
  try {
    await cdp.evaluate(`(async () => {
      const resources = performance.getEntriesByType("resource").map(item => item.name);
      const { render } = await import(resources.find(url => url.includes("/solid-js_web.js")));
      const { PresentedTaskCard } = await import(${JSON.stringify(`${source("../../ui/src/components/task-card.tsx")}?t=${Date.now()}`)});
      const { DataProvider } = await import(${JSON.stringify(source("../../ui/src/context/data.tsx"))});
      const { TaskCardShell } = await import(${JSON.stringify(source("../../app/src/pages/layout/task-panel-shared.tsx"))});
      const host = document.createElement("div");
      host.id = "task-card-regression";
      host.style.cssText = "position:fixed;left:32px;top:100px;width:840px;z-index:10000;padding:24px;background:var(--background-base);display:grid;gap:20px";
      document.body.append(host);
      const description = "Research notes with inline formula SU(2) and a long description. ".repeat(40);
      const project = { kind: "project_task", id: "ptask_regression", title: "Research SU(2) boundary VOA", status: "in_progress",
        progress: { total: 3, completed: 1, inProgress: 1, pending: 1, cancelled: 0 }, sessionCount: 1,
        descriptionPath: ".project-tasks/ptask_regression/prd.md", prdExcerpt: description, time: { created: 1, updated: 1 } };
      const scheduled = { kind: "scheduled_task", id: "task_regression", title: "Scheduled research summary", status: "pending",
        schedule: { kind: "every", interval: 60000 }, enabled: true, nextRunAt: 1800000000000, lastRunAt: 1799996400000,
        agent: "research-agent-with-a-very-long-name", model: { providerID: "test-provider", modelID: "very-long-research-model-name" },
        promptExcerpt: description, time: { created: 1, updated: 1 } };
      const dispose = render(() => DataProvider({ directory: "/tmp", data: { session: [], session_status: {}, session_diff: {}, message: {}, part: {} },
        onOpenTask: value => { window.__taskCardOpened = value.taskID; },
        get children() { return [
          ...[project, scheduled].map(task => PresentedTaskCard({ sessionID: "ses_regression", metadata: { presentedTask: task }, status: "completed" })),
          TaskCardShell({ title: "Project list item", progressKind: "half", "data-component": "project-task-item", onOpen() {} })
        ]; }
      }), host);
      window.__taskCardRegression = { cleanup() { dispose(); host.remove(); delete window.__taskCardOpened; } };
    })()`)
    console.log("[task-card-test] mounted project and scheduled cards")
    for (const width of [840, 360]) {
      await cdp.evaluate(`document.getElementById("task-card-regression").style.width = "${width}px"`)
      const cards = await cdp.evaluate<
        {
          kind: string
          hidden: boolean
          aligned: boolean
          icon: number
          title: number
          font: number
          lines: number
          overflow: boolean
        }[]
      >(`(() => [...document.querySelectorAll("#task-card-regression [data-component=presented-task-card]")].map(card => {
        const icon = card.querySelector("[data-component=icon]").getBoundingClientRect();
        const title = card.querySelector(".presented-task-card__title");
        const heading = title.getBoundingClientRect();
        const text = card.querySelector(".presented-task-card__excerpt-text");
        const style = getComputedStyle(text);
        return { kind: card.dataset.taskKind, hidden: !card.querySelector(".presented-task-card__kind") && !card.textContent.includes(card.dataset.taskId),
          aligned: Math.abs(icon.y + icon.height / 2 - heading.y - heading.height / 2) < 1,
          icon: icon.width, title: parseFloat(getComputedStyle(title).fontSize), font: parseFloat(style.fontSize),
          lines: text.clientHeight / parseFloat(style.lineHeight), overflow: card.scrollWidth > card.clientWidth };
      }))()`)
      assert.equal(cards.length, 2)
      for (const card of cards) {
        assert.ok(card.hidden, "kind labels and task IDs must not be visible")
        assert.ok(card.aligned, "icon and title must share the same center line")
        assert.equal(card.icon, 18)
        assert.equal(card.title, 16)
        assert.equal(card.font, 14)
        assert.equal(card.lines, 3)
        assert.equal(card.overflow, false)
        console.log(
          `[task-card-test] width=${width} kind=${card.kind} icon=${card.icon} title=${card.title} description=${card.font} lines=${card.lines}`,
        )
      }
      const timing = await cdp.evaluate<{ aligned: boolean; icon: boolean; text: string; overflow: boolean }>(`(() => {
        const metrics = document.querySelector("#task-card-regression .presented-task-card__metrics--scheduled");
        const last = metrics.lastElementChild.getBoundingClientRect();
        return { aligned: Math.abs(last.right - metrics.getBoundingClientRect().right) < 1,
          icon: !!metrics.querySelector(".presented-task-card__schedule [data-component=icon]"),
          text: metrics.textContent, overflow: metrics.scrollWidth > metrics.clientWidth };
      })()`)
      assert.ok(timing.aligned, "scheduled times must align to the right edge")
      assert.ok(timing.icon, "schedule must have an alarm icon")
      assert.ok(timing.text.includes("Next ") && timing.text.includes("Last "))
      assert.equal(timing.text.includes("run"), false)
      assert.equal(timing.overflow, false)
      const footer = await cdp.evaluate<{
        aligned: boolean
        truncated: boolean
        titles: boolean
        fullTimes: boolean
        positioned: boolean
        insetLeft: number
        insetRight: number
      }>(`(() => {
        const footer = document.querySelector("#task-card-regression .presented-task-card__footer--scheduled");
        const metadata = footer.querySelector(".presented-task-card__metadata");
        const metrics = footer.querySelector(".presented-task-card__metrics");
        const left = metadata.getBoundingClientRect();
        const right = metrics.getBoundingClientRect();
        const card = footer.closest("[data-component=presented-task-card]");
        const header = card.querySelector("header").getBoundingClientRect();
        const excerpt = card.querySelector(".presented-task-card__excerpt").getBoundingClientRect();
        const row = footer.getBoundingClientRect();
        return { aligned: Math.abs(left.y + left.height / 2 - right.y - right.height / 2) < 1 && left.left < right.left,
          positioned: header.bottom <= row.top && row.bottom <= excerpt.top,
          insetLeft: left.left - row.left,
          insetRight: row.right - right.right,
          truncated: [...metadata.children].some(item => item.scrollWidth > item.clientWidth),
          titles: [...metadata.children].every(item => !!item.title),
          fullTimes: [...metrics.children].every(item => item.scrollWidth <= item.clientWidth) };
      })()`)
      assert.ok(footer.aligned, "metadata and times must share a footer row")
      assert.ok(footer.truncated, "long metadata must truncate to leave room for times")
      assert.ok(footer.titles, "truncated metadata must retain full hover text")
      assert.ok(footer.fullTimes, "time values must remain fully visible")
      assert.ok(footer.positioned, "metadata row must be between the title and description")
      assert.equal(footer.insetLeft, 5, "metadata must be inset by 5px")
      assert.equal(footer.insetRight, 5, "times must be inset by 5px")
      console.log(`[task-card-test] width=${width} timing=right alarm=true labels=short overflow=false row=below-title`)
    }
    await cdp.evaluate('document.querySelector("#task-card-regression .presented-task-card__open").click()')
    assert.equal(await cdp.evaluate("window.__taskCardOpened"), "ptask_regression")
    console.log("[task-card-test] PASS compact layout and task open callback")
    const expectedRadius: Record<string, string> = {
      opencode: "24px",
      claude: "20px",
      chatgpt: "28px",
      arc: "28px",
      aether: "24px",
    }
    for (const theme of Object.keys(expectedRadius)) {
      const radii = await cdp.evaluate<
        {
          kind: string
          outer: string
          inset: string
          button: string
          expected: string
          background: string
          expectedBackground: string
        }[]
      >(`(() => {
        document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)});
        const host = document.getElementById("task-card-regression");
        const probe = document.createElement("div");
        probe.dataset.component = "scheduled-task-card";
        probe.className = "rounded-[var(--task-surface-radius)]";
        probe.style.background = "var(--surface-base)";
        host.append(probe);
        const expected = getComputedStyle(host.querySelector("[data-component=project-task-item]")).borderRadius;
        const expectedBackground = getComputedStyle(probe).backgroundColor;
        if (getComputedStyle(probe).borderRadius !== expected) throw new Error("scheduled and project list radii differ");
        const cards = [...host.querySelectorAll("[data-component=presented-task-card]")].map(card => {
          card.style.transition = "none";
          return {
          kind: card.dataset.taskKind, outer: getComputedStyle(card).borderRadius,
          inset: getComputedStyle(card.querySelector(".presented-task-card__excerpt")).borderRadius,
          button: getComputedStyle(card.querySelector(".presented-task-card__open")).borderRadius, expected,
          background: getComputedStyle(card).backgroundColor, expectedBackground
        }});
        probe.remove();
        return cards;
      })()`)
      for (const card of radii) {
        assert.equal(card.outer, expectedRadius[theme])
        assert.equal(card.outer, card.expected, "conversation and list radii must match")
        assert.equal(card.button, card.outer, "focus border must match the card")
        assert.equal(card.background, card.expectedBackground, "task cards must use the theme's base surface")
        assert.ok(parseFloat(card.inset) < parseFloat(card.outer), "inset corners must be smaller")
        console.log(
          `[task-card-test] theme=${theme} kind=${card.kind} radius=${card.outer} inset=${card.inset} focus=${card.button} background=${card.background}`,
        )
      }
    }
    console.log("[task-card-test] PASS theme-adaptive radii")
    await cdp.call("DOM.enable")
    await cdp.call("CSS.enable")
    const root = await cdp.call<{ root: { nodeId: number } }>("DOM.getDocument")
    const nodes = await cdp.call<{ nodeIds: number[] }>("DOM.querySelectorAll", {
      nodeId: root.root.nodeId,
      selector:
        "#task-card-regression [data-component=presented-task-card], #task-card-regression .presented-task-card__open, #task-card-regression [data-component=project-task-item], [data-component=scheduled-task-card]",
    })
    try {
      for (const state of ["hover", "focus-visible", "active"]) {
        for (const nodeId of nodes.nodeIds) {
          await cdp.call("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [state] })
        }
        const radii = await cdp.evaluate<string[]>(
          `[...document.querySelectorAll("#task-card-regression [data-component=presented-task-card], #task-card-regression [data-component=project-task-item], [data-component=scheduled-task-card]")].map(card => getComputedStyle(card).borderRadius)`,
        )
        for (const radius of radii) assert.equal(radius, expectedRadius.aether)
        await cdp.evaluate(`(() => {
          const host = document.getElementById("task-card-regression");
          const probe = document.createElement("div");
          probe.style.background = "var(--surface-base${state === "hover" ? "-hover" : ""})";
          host.append(probe);
          const expected = getComputedStyle(probe).backgroundColor;
          const cards = [...host.querySelectorAll("[data-component=presented-task-card]")];
          const matches = cards.every(card => getComputedStyle(card).backgroundColor === expected);
          probe.remove();
          if (!matches) throw new Error("task card background mismatch in ${state} state");
        })()`)
        console.log(`[task-card-test] state=${state} surfaces=${radii.length} radius=${expectedRadius.aether}`)
      }
    } finally {
      for (const nodeId of nodes.nodeIds) await cdp.call("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] })
    }
  } finally {
    await cdp.evaluate(
      originalTheme === null
        ? 'document.documentElement.removeAttribute("data-theme")'
        : `document.documentElement.setAttribute("data-theme", ${JSON.stringify(originalTheme)})`,
    )
    await cdp.evaluate("window.__taskCardRegression?.cleanup(); delete window.__taskCardRegression")
  }
})
