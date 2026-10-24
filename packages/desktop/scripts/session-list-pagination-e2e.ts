import { withCdp } from "./cdp"

// Pass two already-open projects with at least 20 and 15 root sessions respectively.
const [first, second] = process.argv.slice(2)
if (!first || !second || first === second) {
  throw new Error("Usage: bun packages/desktop/scripts/session-list-pagination-e2e.ts <project-a> <project-b>")
}

const log = (value: string) => console.log(`[session-list-pagination-e2e] ${value}`)

await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Expected the development renderer")
  const snapshot = () =>
    cdp.evaluate<{ project?: string; rows: number; more: boolean }>(`(() => {
      const panel = [...document.querySelectorAll('[data-component="sidebar-panel"]')]
        .find(el => el.getBoundingClientRect().width > 0);
      const list = panel?.querySelector('[data-slot="sidebar-session-list"]');
      return {
        project: panel?.querySelector('[data-action="project-menu"]')?.getAttribute('data-project'),
        rows: list?.querySelectorAll('a[href*="/session/"]').length ?? 0,
        more: [...(list?.querySelectorAll('button') ?? [])].some(el => el.innerText.trim() === '加载更多' || el.innerText.trim() === 'Load more'),
      };
    })()`)
  const original = await snapshot()
  const select = async (project: string) => {
    const selector = `[data-action="project-switch"][data-project="${project}"]`
    const clicked = await cdp.evaluate<boolean>(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button) return false;
      button.click();
      return true;
    })()`)
    if (!clicked) throw new Error(`Project is not open: ${project}`)
  }
  const check = async (project: string, expected: number) => {
    for (let i = 0; i < 80; i++) {
      const value = await snapshot()
      if (value.project === project && value.rows === expected) {
        log(`PASS project=${Buffer.from(project, "base64url").toString()} rows=${value.rows}`)
        return
      }
      await Bun.sleep(100)
    }
    const value = await snapshot()
    throw new Error(`Expected project=${project} rows=${expected}; got project=${value.project} rows=${value.rows}`)
  }
  const more = async () => {
    if (!(await snapshot()).more) throw new Error("Expected a load-more button; use projects with enough sessions")
    await cdp.evaluate(`(() => {
      const panel = [...document.querySelectorAll('[data-component="sidebar-panel"]')]
        .find(el => el.getBoundingClientRect().width > 0);
      const button = [...panel.querySelectorAll('[data-slot="sidebar-session-list"] button')]
        .find(el => el.innerText.trim() === '加载更多' || el.innerText.trim() === 'Load more');
      button.click();
    })()`)
  }
  const a = Buffer.from(first).toString("base64url")
  const b = Buffer.from(second).toString("base64url")
  try {
    await select(a)
    await check(a, 10)
    await select(b)
    await check(b, 10)
    await select(a)
    await more()
    await check(a, 15)
    await select(b)
    await check(b, 10)
    await more()
    await check(b, 15)
    await select(a)
    await check(a, 15)
    await more()
    await check(a, 20)
    await select(b)
    await check(b, 15)
    await select(a)
    await check(a, 20)
    log("PASS independent pagination and retained limits across project switches")
  } finally {
    if (original.project) await select(original.project)
  }
})
