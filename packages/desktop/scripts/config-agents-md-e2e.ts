import { withCdp } from "./cdp"
import { fileURLToPath } from "node:url"

const log = (message: string) => console.log(`[config-agents-md-e2e] ${message}`)

await withCdp(async (cdp, target) => {
  if (!target.url.includes("localhost:5173")) throw new Error("Expected development Electron")
  const directory = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "")
  const navigation = `${new URL(target.url).origin}/@fs${fileURLToPath(new URL("../../app/src/utils/notification-click.ts", import.meta.url))}`
  const token = `qa-agents-md-${Date.now()}`
  const wait = async (label: string, predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const read = (path: string) => cdp.evaluate<string | null>(`window.api.readLocalFile(${JSON.stringify(path)})`)
  const editor = "[data-config-agents-md-editor]"
  const text = () => cdp.evaluate<string>(`document.querySelector('${editor} textarea')?.value`)
  const edit = async (value: string) => {
    await cdp.evaluate(`(() => {
      const el = document.querySelector('${editor} textarea');
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", {bubbles:true}));
    })()`)
  }
  const save = async () => {
    await wait("save enabled", () =>
      cdp.evaluate(`!!document.querySelector('${editor} [data-config-save-state=active]:not(:disabled)')`),
    )
    await cdp.evaluate(`document.querySelector('${editor} [data-config-save-state=active]').click()`)
  }
  const cancel = async () => {
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('${editor} button')].find(el => ["取消", "Cancel"].includes(el.textContent.trim()));
      if (!button) throw new Error("Missing cancel button");
      button.click();
    })()`)
  }
  const isDraft = () =>
    cdp.evaluate<boolean>(
      `[...document.querySelectorAll('${editor} button')].some(el => ["取消", "Cancel"].includes(el.textContent.trim()))`,
    )
  const menu = async () => {
    await wait("create trigger enabled", () =>
      cdp.evaluate('!!document.querySelector("[data-config-create=agents-md]:not(:disabled)")'),
    )
    await cdp.evaluate('document.querySelector("[data-config-create=agents-md]").focus()')
    for (const type of ["keyDown", "keyUp"])
      await cdp.call("Input.dispatchKeyEvent", { type, key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 })
    await wait("scope menu open", () => cdp.evaluate('!!document.querySelector("[data-config-create-menu=agents-md]")'))
    await cdp.evaluate(
      'Promise.all(document.querySelector("[data-config-create-menu=agents-md]").getAnimations().map(animation => animation.finished)).then(() => true)',
    )
    return cdp.evaluate<string[]>(
      '[...document.querySelectorAll("[data-config-create-menu=agents-md] [role=menuitem] [title]")].map(el => el.title)',
    )
  }
  const choose = async (root: string, global = false) => {
    const roots = await menu()
    const index = global ? 0 : roots.indexOf(root)
    if (index < 0) throw new Error(`Project not in menu: ${root}`)
    const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const item = document.querySelectorAll("[data-config-create-menu=agents-md] [role=menuitem]")[${index}];
      item.scrollIntoView({block:"nearest"});
      const rect = item.getBoundingClientRect();
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`)
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
    await wait("scope menu closed", () =>
      cdp.evaluate('!document.querySelector("[data-config-create-menu=agents-md]")'),
    )
    const path = `${root}/AGENTS.md`
    await wait("selected file loaded", () =>
      cdp.evaluate(
        `document.querySelector('${editor}')?.getAttribute("data-agents-md-path") === ${JSON.stringify(path)} && !!document.querySelector('${editor} textarea')`,
      ),
    )
  }
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization()",
  )
  const request = async (path: string, root: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${connection.url}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "x-opencode-directory": encodeURIComponent(root),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`)
    return response.json()
  }
  const route = `/${Buffer.from(directory).toString("base64url")}/config?section=agents-md`
  await cdp.evaluate(
    `(() => { void import(${JSON.stringify(navigation)}).then(m => m.handleNotificationClick(${JSON.stringify(route)})); return true })()`,
  )
  await wait("project groups", () => cdp.evaluate('document.querySelectorAll("[data-agents-md-project]").length > 0'))
  const roots = await cdp.evaluate<string[]>(
    '[...document.querySelectorAll("[data-agents-md-project]")].map(el => el.getAttribute("data-agents-md-project"))',
  )
  const workspace = await cdp.evaluate<{ configRoot: string; agentsMdPath: string }>("window.api.getConfigWorkspace()")
  const globalBefore = await read(workspace.agentsMdPath)
  const repositoryBefore = await read(`${directory}/AGENTS.md`)
  await choose(directory)
  await wait("existing project instructions", async () => (await text()) === repositoryBefore)
  if (await isDraft()) throw new Error("Existing project file became a draft")
  log("PASS existing project AGENTS.md opens without replacing content")
  await choose(workspace.configRoot, true)
  await wait("global instructions", async () =>
    globalBefore === null ? await isDraft() : (await text()) === globalBefore,
  )
  if (globalBefore === null) await cancel()
  if ((await read(workspace.agentsMdPath)) !== globalBefore) throw new Error("Global file changed while opening")
  log("PASS global scope preserves existing file")
  const cards = await cdp.evaluate<
    { label: string; radius: number; border: number; padding: number; icon: boolean }[]
  >(`(() => {
    const list = document.querySelector('[data-config-agents-md-list]');
    const group = document.querySelector('[data-agents-md-project=${JSON.stringify(directory)}]');
    const global = [...list.querySelectorAll('button')].find(el => !el.closest('[data-agents-md-project]'));
    const project = [...group.querySelectorAll('button')].find(el => el.textContent.trim().startsWith('AGENTS.md'));
    return [global, project].map(el => {
      if (!el) throw new Error('Missing AGENTS.md card');
      const style = getComputedStyle(el);
      return {label:el.textContent.trim().slice(0, 20),radius:parseFloat(style.borderRadius),border:parseFloat(style.borderTopWidth),padding:parseFloat(style.paddingLeft),icon:!!el.querySelector('[data-component=icon]')};
    });
  })()`)
  for (const card of cards) {
    if (card.radius < 6 || card.border < 1 || card.padding < 16 || !card.icon)
      throw new Error(`AGENTS.md card does not match skill card styling: ${JSON.stringify(card)}`)
    log(
      `PASS skill-style card label=${card.label} radius=${card.radius} border=${card.border} padding=${card.padding} icon=${card.icon}`,
    )
  }
  let project = ""
  for (const root of roots
    .filter((root) => root !== directory)
    .sort((a, b) => Number(b.endsWith("/fiction")) - Number(a.endsWith("/fiction")))) {
    if ((await read(`${root}/AGENTS.md`)) === null) {
      project = root
      break
    }
  }
  if (!project) throw new Error("Need one loaded project without AGENTS.md to test creation safely")
  const path = `${project}/AGENTS.md`
  let owned = false
  try {
    await choose(project)
    if (!(await isDraft()) || (await read(path)) !== null) throw new Error("New draft wrote a file before save")
    const draft = `# ${token}\n\nDraft instructions.\n`
    await edit(draft)
    await choose(workspace.configRoot, true)
    if (globalBefore === null) await cancel()
    await cdp.evaluate(`(() => {
      const group = document.querySelector('[data-agents-md-project=${JSON.stringify(project)}]');
      const button = [...group.querySelectorAll("button")].find(el => el.textContent.trim().startsWith("AGENTS.md"));
      if (!button) throw new Error("Missing draft list item");
      button.click();
    })()`)
    await wait("draft preserved", async () => (await text()) === draft && (await isDraft()))
    await wait("draft still saveable", () =>
      cdp.evaluate(`!!document.querySelector('${editor} [data-config-save-state=active]')`),
    )
    await cancel()
    if ((await read(path)) !== null) throw new Error("Cancelled draft created a file")
    log("PASS draft survives selection changes and cancellation writes nothing")
    await cdp.evaluate(
      `document.querySelector('[data-agents-md-project=${JSON.stringify(project)}] button[title="新建 AGENTS.md"], [data-agents-md-project=${JSON.stringify(project)}] button[title="New AGENTS.md"]').click()`,
    )
    await wait(
      "project group create action",
      async () =>
        (await isDraft()) &&
        (await cdp.evaluate(
          `document.querySelector('${editor}')?.getAttribute("data-agents-md-path") === ${JSON.stringify(path)}`,
        )),
    )
    log("PASS project group + creates in the selected project")
    const content = `# ${token}\n\nProject instructions created in the configuration page.\n`
    await edit(content)
    owned = true
    await save()
    await wait("created file", async () => (await read(path)) === content && !(await isDraft()))
    const edited = `${content}\nUpdated project instructions.\n`
    await edit(edited)
    await save()
    await wait("edited file", async () => (await read(path)) === edited)
    const backend = await request("/file/content?path=AGENTS.md", project)
    if (backend.content !== edited.trim()) throw new Error("Sidecar did not read the edited project file")
    await choose(project)
    await wait("existing content preserved", async () => (await text()) === edited && !(await isDraft()))
    log(`PASS created, edited, reopened and read through sidecar path=${path}`)
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-config-agents-md-list] input');
      input.value = ${JSON.stringify(project)};
      input.dispatchEvent(new Event("input", {bubbles:true}));
    })()`)
    await wait("project search", () =>
      cdp.evaluate('document.querySelectorAll("[data-agents-md-project]").length === 1'),
    )
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-config-agents-md-list] input');
      input.value = "";
      input.dispatchEvent(new Event("input", {bubbles:true}));
    })()`)
    await wait("search cleared", () =>
      cdp.evaluate(`document.querySelectorAll("[data-agents-md-project]").length === ${roots.length}`),
    )
    log("PASS project search filters and restores the project list")
    const screenshot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write("/tmp/opencode-agents-md.png", Buffer.from(screenshot.data, "base64"))
    await cdp.evaluate(`window.api.deleteLocalFile(${JSON.stringify(path)})`)
    await choose(project)
    const collision = `# ${token}\n\nConcurrent creator must not be overwritten.\n`
    await cdp.evaluate(`window.api.createLocalFile(${JSON.stringify(path)},${JSON.stringify(collision)})`)
    await edit("# Do not overwrite the concurrent file\n")
    await save()
    await wait("exclusive creation rejected", () => cdp.evaluate('document.body.innerText.includes("EEXIST")'))
    if ((await read(path)) !== collision) throw new Error("Concurrent file was overwritten")
    await cancel()
    log("PASS exclusive creation protects a concurrently created file")
    await cdp.evaluate(`window.api.deleteLocalFile(${JSON.stringify(path)})`)
    await choose(project)
    await edit("")
    await save()
    await wait("empty file created", async () => (await read(path)) === "" && !(await isDraft()))
    log("PASS a new empty AGENTS.md can be saved")
    await choose(project)
    await wait("empty file treated as existing", async () => (await text()) === "" && !(await isDraft()))
    log("PASS existing empty AGENTS.md is not mistaken for a missing file")
    const session = await request("/session", project, "POST", { title: token })
    try {
      await request(`/session/${session.id}/message`, project, "POST", {
        noReply: true,
        parts: [{ type: "text", text: token }],
      })
      const messages = await request(`/session/${session.id}/message`, project)
      if (!messages.some((row: { parts: { text?: string }[] }) => row.parts.some((part) => part.text === token)))
        throw new Error("Sidecar did not persist the test message")
      log("PASS sidecar received and returned the test message without an LLM request")
    } finally {
      await request(`/session/${session.id}`, project, "DELETE")
    }
  } finally {
    const current = await read(path)
    if (owned && (current === "" || current?.includes(token)))
      await cdp.evaluate(`window.api.deleteLocalFile(${JSON.stringify(path)})`)
    if (
      (await read(workspace.agentsMdPath)) !== globalBefore ||
      (await read(`${directory}/AGENTS.md`)) !== repositoryBefore
    )
      throw new Error("Existing instructions unexpectedly changed")
    log("owned test file cleaned; existing global and repository instructions unchanged")
  }
})
