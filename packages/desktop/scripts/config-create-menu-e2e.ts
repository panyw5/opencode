import { withCdp } from "./cdp"
import { fileURLToPath } from "node:url"
import { rmdir } from "node:fs/promises"

const directory = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "")
const log = (message: string) => console.log(`[config-create-e2e] ${message}`)

await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Expected the development Electron renderer")
  const navigation = `${new URL(target.url).origin}/@fs${fileURLToPath(new URL("../../app/src/utils/notification-click.ts", import.meta.url))}`
  const wait = async (label: string, predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const click = async (selector: string) => {
    await wait(selector, () => cdp.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`))
    const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({block: "nearest"});
      const rect = el.getBoundingClientRect();
      return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    })()`)
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
  }
  const navigate = async (section: string) => {
    const route = `/${Buffer.from(directory).toString("base64url")}/config?section=${section}`
    await cdp.evaluate(
      `(() => { void import(${JSON.stringify(navigation)}).then(m => m.handleNotificationClick(${JSON.stringify(route)})); return true })()`,
    )
  }
  const workspace = await cdp.evaluate<{ configRoot: string; skillsRoot: string }>("window.api.getConfigWorkspace()")
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization()",
  )
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${connection.url}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "x-opencode-directory": encodeURIComponent(directory),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`)
    return response.json()
  }
  const files: string[] = []
  const skillFolders: string[] = []
  const token = `qa-scope-${Date.now()}`
  let projectRoots: string[] = []
  try {
    for (const kind of ["skill", "command"] as const) {
      await navigate(kind === "skill" ? "skills" : "commands")
      const trigger = `[data-config-create="${kind}"]`
      const menu = `[data-config-create-menu="${kind}"]`
      const input =
        kind === "skill"
          ? "input[placeholder='新建自定义技能'], input[placeholder='New custom skill']"
          : "input[placeholder='命令名称（如 review-code）'], input[placeholder='Command name (e.g. review-code)']"
      for (const scope of ["global", "project"] as const) {
        await wait("create trigger", () => cdp.evaluate(`!!document.querySelector(${JSON.stringify(trigger)})`))
        await cdp.evaluate(`document.querySelector(${JSON.stringify(trigger)}).focus()`)
        await cdp.call("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "ArrowDown",
          code: "ArrowDown",
          windowsVirtualKeyCode: 40,
        })
        await cdp.call("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "ArrowDown",
          code: "ArrowDown",
          windowsVirtualKeyCode: 40,
        })
        await wait("menu expanded", () =>
          cdp.evaluate(`document.querySelector(${JSON.stringify(trigger)})?.getAttribute("aria-expanded") === "true"`),
        )
        await wait("keyboard highlight", () =>
          cdp.evaluate(`(() => {
          const item = document.querySelector('${menu} [data-highlighted]');
          return !!item && getComputedStyle(item).boxShadow !== "none";
        })()`),
        )
        log(`PASS keyboard highlight kind=${kind}`)
        const height = await cdp.evaluate<number>(
          `document.querySelector(${JSON.stringify(menu)}).getBoundingClientRect().height`,
        )
        log(`menu height=${height.toFixed(0)}px`)
        if (height > 640) throw new Error("Menu exceeds the requested maximum height")
        const roots = await cdp.evaluate<string[]>(
          `[...document.querySelectorAll('${menu} [role="menuitem"] [title]')].map(el => el.title)`,
        )
        if (!roots.includes(directory)) throw new Error(`Loaded project missing: ${directory}`)
        if (kind === "skill") projectRoots = roots.slice(1)
        else if (JSON.stringify(projectRoots) !== JSON.stringify(roots.slice(1)))
          throw new Error("Project targets differ between skill and command menus")
        log(`menu kind=${kind} scope=${scope} projects=${roots.length - 1}`)
        const hoverItem = `${menu} [role="menuitem"]:has([title="${directory}"])`
        const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
          const item = document.querySelector(${JSON.stringify(hoverItem)});
          item.scrollIntoView({block: "nearest"});
          const rect = item.getBoundingClientRect();
          return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
        })()`)
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
        await wait("mouse hover highlight", () =>
          cdp.evaluate(`(() => {
          const item = document.querySelector(${JSON.stringify(hoverItem)});
          if (!item?.matches(":hover")) return false;
          const style = getComputedStyle(item);
          return style.boxShadow !== "none" && style.backgroundColor !== "rgba(0, 0, 0, 0)";
        })()`),
        )
        const highlight = await cdp.evaluate<string>(`(() => {
          const style = getComputedStyle(document.querySelector(${JSON.stringify(hoverItem)}));
          return "background=" + style.backgroundColor + " border=" + style.boxShadow;
        })()`)
        log(`PASS mouse hover kind=${kind} ${highlight}`)
        if (kind === "skill" && scope === "global") {
          await cdp.evaluate(
            `Promise.all(document.querySelector(${JSON.stringify(menu)}).getAnimations().map(animation => animation.finished)).then(() => true)`,
          )
          const screenshot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
          await Bun.write("/tmp/opencode-create-menu-hover.png", Buffer.from(screenshot.data, "base64"))
        }
        if (scope === "global") await click(`${menu} [role="menuitem"]`)
        else {
          const index = roots.indexOf(directory)
          await click(`${menu} [role="menuitem"]:has([title="${directory}"])`)
          if (index < 1) throw new Error("Expected a project target after global")
        }
        await wait("creator input", () => cdp.evaluate(`!!document.querySelector(${JSON.stringify(input)})`))
        const name = `${token}-${kind}-${scope}`
        const root =
          scope === "project"
            ? `${directory}/.opencode/${kind === "skill" ? "skills" : "commands"}`
            : kind === "skill"
              ? workspace.skillsRoot
              : `${workspace.configRoot}/commands`
        const path = kind === "skill" ? `${root}/${name}/SKILL.md` : `${root}/${name}.md`
        files.push(path)
        if (kind === "skill") skillFolders.push(`${root}/${name}`)
        await cdp.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(input)});
          el.value = ${JSON.stringify(name)};
          el.dispatchEvent(new Event("input", {bubbles:true}));
        })()`)
        await wait("save enabled", () =>
          cdp.evaluate('!!document.querySelector("[data-config-save-state=active]:not(:disabled)")'),
        )
        await cdp.evaluate('document.querySelector("[data-config-save-state=active]:not(:disabled)").click()')
        await wait("file saved", () =>
          cdp.evaluate(
            `window.api.readLocalFile(${JSON.stringify(path)}).then(text => !!text?.includes(${JSON.stringify(name)}))`,
          ),
        )
        await wait("creator closed", () => cdp.evaluate(`!document.querySelector(${JSON.stringify(input)})`))
        if (kind === "command") {
          await wait("sidecar command loaded", async () =>
            (await request("/command")).some((item: { name: string }) => item.name === name),
          )
        }
        log(`PASS saved kind=${kind} scope=${scope} path=${path}`)
      }
    }
    await request("/instance/dispose", "POST")
    const skills = await request("/skill")
    for (const scope of ["global", "project"]) {
      if (!skills.some((item: { name: string }) => item.name === `${token}-skill-${scope}`))
        throw new Error(`Sidecar skill missing: ${scope}`)
    }
    log("PASS sidecar discovers both new skills")
    const session = await request("/session", "POST", { title: token })
    try {
      const message = `Configuration scope smoke test ${token}`
      await request(`/session/${session.id}/message`, "POST", {
        noReply: true,
        parts: [{ type: "text", text: message }],
      })
      const messages = await request(`/session/${session.id}/message`)
      if (
        !messages.some((row: { parts: { type: string; text?: string }[] }) =>
          row.parts.some((part) => part.type === "text" && part.text === message),
        )
      )
        throw new Error("Sidecar did not persist the test message")
      log("PASS sent and verified a sidecar message without an LLM request")
    } finally {
      await request(`/session/${session.id}`, "DELETE")
    }
  } finally {
    for (const path of files) {
      await cdp.evaluate(`window.api.deleteLocalFile(${JSON.stringify(path)}).catch(() => {})`)
    }
    for (const folder of skillFolders) await rmdir(folder).catch(() => {})
    await request("/instance/dispose", "POST")
    log("owned test files cleaned")
  }
})
