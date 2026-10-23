import { withCdp } from "./cdp"
import { fileURLToPath } from "node:url"
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { parse } from "jsonc-parser"
import { formatArgv, selectProjectMcpConfig, updateProjectMcpText } from "../../app/src/pages/config-persistence"

const log = (message: string) => console.log(`[config-mcp-e2e] ${message}`)

if (process.argv[2] === "--fixture") {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line)
    appendFileSync(process.argv[3], `${request.method}\n`)
    if (request.id === undefined) continue
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "scope-qa", version: "1" },
          }
        : request.method === "tools/list"
          ? { tools: [] }
          : {}
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
  }
} else
  await withCdp(async (cdp, target) => {
    if (!target.url.includes("localhost:5173")) throw new Error("Expected development Electron")
    const directory = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "")
    const navigation = `${new URL(target.url).origin}/@fs${fileURLToPath(new URL("../../app/src/utils/notification-click.ts", import.meta.url))}`
    const token = `qa-mcp-${Date.now()}`
    const protocolLog = `/tmp/${token}.log`
    const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
      "window.api.awaitInitialization()",
    )
    const request = async (path: string, dir: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${connection.url}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
          "x-opencode-directory": encodeURIComponent(dir),
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${await response.text()}`)
      return response.json()
    }
    const wait = async (label: string, predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 600; i++) {
        if (await predicate()) return
        await Bun.sleep(100)
      }
      throw new Error(`Timed out: ${label}`)
    }
    const input = async (selector: string, value: string) => {
      await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Missing input");
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", {bubbles:true}));
      el.dispatchEvent(new Event("change", {bubbles:true}));
    })()`)
    }
    const owned: { path: string; name: string; directory: string }[] = []
    const navigate = async () => {
      const route = `/${Buffer.from(directory).toString("base64url")}/config?section=mcp`
      await cdp.evaluate(
        `(() => { void import(${JSON.stringify(navigation)}).then(m => m.handleNotificationClick(${JSON.stringify(route)})); return true })()`,
      )
      await wait("MCP menu trigger", () => cdp.evaluate('!!document.querySelector("[data-config-create=mcp]")'))
    }
    try {
      await navigate()
      for (const scope of ["global", "project"] as const) {
        await cdp.evaluate('document.querySelector("[data-config-create=mcp]").focus()')
        for (const type of ["keyDown", "keyUp"])
          await cdp.call("Input.dispatchKeyEvent", {
            type,
            key: "ArrowDown",
            code: "ArrowDown",
            windowsVirtualKeyCode: 40,
          })
        await wait("MCP scope menu", () => cdp.evaluate('!!document.querySelector("[data-config-create-menu=mcp]")'))
        await wait("MCP keyboard highlight", () =>
          cdp.evaluate(
            '(() => { const item = document.querySelector("[data-config-create-menu=mcp] [data-highlighted]"); return !!item && getComputedStyle(item).boxShadow !== "none" })()',
          ),
        )
        const roots = await cdp.evaluate<string[]>(
          '[...document.querySelectorAll("[data-config-create-menu=mcp] [role=menuitem] [title]")].map(el => el.title)',
        )
        const otherProject =
          roots.slice(1).find((root) => root !== directory && root.endsWith("/chat")) ??
          roots.slice(1).find((root) => root !== directory)
        if (!otherProject) throw new Error("Expected another loaded project to test non-current targeting")
        const targetDir = scope === "global" ? "" : otherProject
        const index = scope === "global" ? 0 : roots.indexOf(targetDir)
        log(`select scope=${scope} directory=${targetDir} loadedProjects=${roots.length - 1}`)
        await cdp.evaluate(
          'Promise.all(document.querySelector("[data-config-create-menu=mcp]").getAnimations().map(animation => animation.finished)).then(() => true)',
        )
        const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
          const item = document.querySelectorAll("[data-config-create-menu=mcp] [role=menuitem]")[${index}];
          item.scrollIntoView({block:"nearest"});
          const rect = item.getBoundingClientRect();
          return {x:rect.x + rect.width/2, y:rect.y + rect.height/2};
        })()`)
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
        await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
        await wait("MCP creator", () => cdp.evaluate('!!document.querySelector("input[placeholder=my-mcp-server]")'))
        if (
          !(await cdp.evaluate(`!!document.querySelector('[data-mcp-target-directory=${JSON.stringify(targetDir)}]')`))
        )
          throw new Error("Wrong editor target")
        const name = `${token}-${scope}`
        const files = await cdp.evaluate<any[]>(`window.api.listConfigFiles(${JSON.stringify(targetDir || null)})`)
        const records = files
          .filter((file) => file.scope === scope && file.kind === "config")
          .map((file) => ({ file, text: "{}" }))
        const configFile = selectProjectMcpConfig(records, name, true)
        if (!configFile) throw new Error("No target config file")
        owned.push({ path: configFile.file.path, name, directory: targetDir || directory })
        const command = formatArgv([process.execPath, fileURLToPath(import.meta.url), "--fixture", protocolLog])
        await input("input[placeholder=my-mcp-server]", name)
        await input('input[placeholder="npx -y @modelcontextprotocol/server-filesystem /path"]', command)
        await cdp.evaluate('document.querySelector("[data-config-save-state=active]:not(:disabled)").click()')
        await wait("MCP config written", async () => {
          const text = await cdp.evaluate<string | null>(
            `window.api.readLocalFile(${JSON.stringify(configFile.file.path)})`,
          )
          return parse(text ?? "{}")?.mcp?.[name]?.command?.includes("--fixture")
        })
        await wait(
          "MCP connected in sidecar",
          async () => (await request("/mcp", targetDir || directory))[name]?.status === "connected",
        )
        await wait("MCP save complete", () =>
          cdp.evaluate(
            '!document.querySelector("input[placeholder=my-mcp-server]") && !!document.querySelector("[data-config-save-state=disabled]")',
          ),
        )
        const savedCommand = await cdp.evaluate<string>(
          "document.querySelector('input[placeholder=\"npx -y @modelcontextprotocol/server-filesystem /path\"]')?.value",
        )
        if (savedCommand !== command) throw new Error("Saved project editor lost its configuration")
        log(`PASS saved and connected scope=${scope} path=${configFile.file.path}`)
        if (scope === "project") {
          const toggle = async (enabled: boolean) => {
            await cdp.evaluate(`(() => {
              const control = [...document.querySelectorAll('input[role="switch"]')].find(el => el.getAttribute("aria-label") === ${JSON.stringify(name)} || document.getElementById(el.getAttribute("aria-labelledby"))?.textContent.trim() === ${JSON.stringify(name)});
              if (!control) throw new Error("Missing project MCP switch");
              control.click();
            })()`)
            await wait("project MCP connection toggled", async () => {
              const status = (await request("/mcp", targetDir))[name]?.status
              return enabled ? status === "connected" : status === "disabled"
            })
            await wait("project MCP switch idle", () =>
              cdp.evaluate("!document.querySelector('input[role=\"switch\"]:disabled')"),
            )
            log(`PASS project MCP toggle enabled=${enabled}`)
          }
          await toggle(false)
          await toggle(true)
        }
        await cdp.evaluate(
          '(() => { const button = [...document.querySelectorAll("button")].find(el => ["删除", "Delete"].includes(el.textContent.trim())); if (!button) throw new Error("Missing delete button"); button.click() })()',
        )
        await wait("MCP deletion persisted", async () => {
          const text = await cdp.evaluate<string | null>(
            `window.api.readLocalFile(${JSON.stringify(configFile.file.path)})`,
          )
          return !Object.hasOwn(parse(text ?? "{}")?.mcp ?? {}, name)
        })
        await wait("MCP deletion complete in UI", () =>
          cdp.evaluate('!document.querySelector("[data-mcp-target-directory]")'),
        )
        log(`PASS deleted scope=${scope}`)
      }
      const messages = await Bun.file(protocolLog).text()
      if (!messages.includes("initialize") || !messages.includes("tools/list"))
        throw new Error("MCP protocol handshake missing")
      log(`PASS MCP fixture received initialize and tools/list requests`)
    } finally {
      for (const file of owned) {
        const text = await cdp.evaluate<string | null>(`window.api.readLocalFile(${JSON.stringify(file.path)})`)
        if (text && Object.hasOwn(parse(text)?.mcp ?? {}, file.name)) {
          const next = updateProjectMcpText(text, file.name, undefined)
          await cdp.evaluate(`window.api.writeLocalFile(${JSON.stringify(file.path)}, ${JSON.stringify(next)})`)
        }
        await request("/instance/dispose", file.directory, "POST")
      }
      log("owned MCP entries cleaned without replacing other configuration")
    }
  })
