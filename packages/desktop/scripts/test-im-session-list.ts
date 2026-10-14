import { strict as assert } from "node:assert"
import { withCdp } from "./cdp"

// Run against the dev renderer with a regular project session open and at
// least one enabled IM channel. Only list selections and existing tabs change.
await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const state = () =>
    cdp.evaluate<{
      tabs: { id: string | null; directory: string | null; active: string | null }[]
      session: string | null
    }>(`({
      tabs: [...document.querySelectorAll('[data-component="session-tab"]')].map(e => ({
        id: e.getAttribute('data-session-id') || e.getAttribute('data-draft-id'),
        directory: e.getAttribute('data-directory'),
        active: e.getAttribute('data-active')
      })),
      session: document.querySelector('[data-component="session-page"]')?.getAttribute('data-session-id') ?? null
    })`)
  const wait = async (expression: string) => {
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      if (await cdp.evaluate<boolean>(expression)) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${expression}`)
  }
  const click = async (selector: string) => {
    assert.ok(
      await cdp.evaluate<boolean>(`(() => {
        const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return false;
        e.click();
        return true;
      })()`),
      `missing control: ${selector}`,
    )
  }
  const menu = async () => {
    const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const e = document.querySelector('[data-component="sidebar-rail"] button[data-icon="speech-bubble"]');
      if (!e) throw new Error('IM rail control missing');
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`)
    // Move away first so reopening the hover menu always generates mouseenter.
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 40 })
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
    await wait(`!!document.querySelector('[data-component="popover-content"] button')`)
  }
  const select = async (label: string) => {
    await menu()
    assert.ok(
      await cdp.evaluate<boolean>(`(() => {
        const e = [...document.querySelectorAll('[data-component="popover-content"] button')]
          .find(e => e.textContent.trim() === ${JSON.stringify(label)});
        if (!e) return false;
        e.click();
        return true;
      })()`),
      `missing channel: ${label}`,
    )
  }
  const visible = `(() => {
    const e = document.querySelector('[data-component="im-channel-heading"]');
    return !!e && !e.closest('[aria-hidden="true"]');
  })()`
  const unchanged = async (before: Awaited<ReturnType<typeof state>>, step: string) => {
    // Catch late load completions and project-index fallback draft creation.
    await Bun.sleep(700)
    assert.deepEqual(await state(), before, `${step}: list selection must not change page or tabs`)
    console.log(`[im-session-list-test] PASS ${step} tabs=${before.tabs.length} session=${before.session ?? "home"}`)
  }

  const initial = await state()
  assert.ok(initial.session, "start with a regular project session open")
  const project = await cdp.evaluate<string | null>(
    `document.querySelector('[data-action="project-switch"][data-session-current="true"]')?.getAttribute('data-project') ?? null`,
  )
  assert.ok(project, "current session must belong to a regular project")
  const projectSelector = `[data-action="project-switch"][data-project="${project}"]`
  await click(projectSelector)
  await unchanged(initial, "select regular project")
  await menu()
  const labels = await cdp.evaluate<string[]>(
    `[...document.querySelectorAll('[data-component="popover-content"] button')].filter(e => !e.disabled).map(e => e.textContent.trim())`,
  )
  assert.ok(labels.length > 0 && labels.every((label) => label.includes(" | ")), "enabled IM channels required")

  for (const label of labels) {
    await select(label)
    await wait(visible)
    await unchanged(initial, `open ${label}`)
    await select(label)
    await wait(`!(${visible})`)
    await unchanged(initial, `collapse ${label}`)
    await select(label)
    await wait(visible)
    await unchanged(initial, `reopen ${label}`)
  }

  const row = '[data-component="sidebar-session"] a'
  if (await cdp.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(row)})`)) {
    await click(row)
    await wait(
      `document.querySelector('[data-component="session-page"]')?.getAttribute('data-session-id') !== ${JSON.stringify(initial.session)}`,
    )
    const imSession = await state()
    assert.ok(imSession.session, "clicking a channel session must open the actual session")
    await click(projectSelector)
    await unchanged(imSession, "select project while viewing IM session")
    const added = imSession.tabs.filter((tab) => !initial.tabs.some((item) => item.id === tab.id))
    for (const tab of added) {
      await click(`[data-component="session-tab"][data-session-id="${tab.id}"] [aria-label]`)
    }
  }

  await click('[data-action="home-open"]')
  await wait(`!document.querySelector('[data-component="session-page"]')`)
  const home = await state()
  for (const label of labels) {
    await select(label)
    await wait(visible)
    await unchanged(home, `open from home ${label}`)
  }

  await click(`[data-component="session-tab"][data-session-id="${initial.session}"]`)
  await wait(
    `document.querySelector('[data-component="session-page"]')?.getAttribute('data-session-id') === ${JSON.stringify(initial.session)}`,
  )
  await click(projectSelector)
  assert.deepEqual(await state(), initial, "restore original tabs and session")
  console.log(`[im-session-list-test] PASS channels=${labels.length} no-drafts no-auto-navigation`)
})
