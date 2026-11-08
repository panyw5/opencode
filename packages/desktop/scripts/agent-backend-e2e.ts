import { strict as assert } from "node:assert"
import { fork, spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { connectCdp, listTargets } from "./cdp"

const log = (value: string) => console.log(`[agent-backend-e2e] ${value}`)
const desktop = process.argv.includes("--desktop")
const installUI = process.argv.includes("--install-ui")
const endpoint = process.env.OPENCODE_CDP_ENDPOINT ?? "http://127.0.0.1:9233"
const cdpPort = new URL(endpoint).port
const root = path.resolve(import.meta.dir, "../../..")
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-agent-backend-e2e-")))
const workspace = path.join(temporary, "workspace")
const fixture = path.join(root, "packages/opencode/test/fixture")
await mkdir(workspace)
await mkdir(path.join(temporary, "dsh-home"))
for (const name of ["codex-home", "claude-home", "pi-home"]) await mkdir(path.join(temporary, name))
const dsh = path.join(temporary, "dsh-fixture.mjs")
await copyFile(path.join(root, "packages/opencode/test/tool/fixtures/dsh-consult-cli.js"), dsh)
await chmod(dsh, 0o700)
const counts = new Map<string, number>()
const scenarios = {
  BACKEND_ACP: { tool: "claude_consult", backend: "acp", answer: "ACP_REPLY_1" },
  BACKEND_RPC: { tool: "pi_consult", backend: "native-rpc", answer: "PI_REPLY_1" },
  BACKEND_CLI: { tool: "dsh_consult", backend: "cli-json", answer: "Initial fixture answer" },
} as const
const model = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: unknown[]; tools?: unknown[] }
    const context = JSON.stringify(body.messages)
    const scenario = body.tools?.length
      ? (Object.keys(scenarios).find((name) => context.includes(name)) as keyof typeof scenarios | undefined)
      : undefined
    const count = scenario ? (counts.get(scenario) ?? 0) + 1 : 0
    if (scenario) counts.set(scenario, count)
    const tool = scenario && count === 1 ? scenarios[scenario].tool : undefined
    log(`model scenario=${scenario ?? "title"} step=${count} tool=${tool ?? "none"}`)
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call_${scenario}`,
              type: "function",
              function: { name: tool, arguments: JSON.stringify({ prompt: "Review the fixture" }) },
            },
          ],
        }
      : { content: `${scenario ?? "TITLE"}_OK` }
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
      id: "chatcmpl-backend",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })
    return new Response(
      [chunk({ role: "assistant" }), chunk(delta), chunk({}, tool ? "tool_calls" : "stop")]
        .map((value) => `data: ${JSON.stringify(value)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      {
        headers: { "Content-Type": "text/event-stream" },
      },
    )
  },
})
const config = {
  model: "backend-fixture/fixture",
  small_model: "backend-fixture/fixture",
  plugin: [],
  mcp: {},
  permission: { "*": "allow" },
  agent_backends: { claude: { type: "acp", command: ["node", path.join(fixture, "acp-agent.mjs")] } },
  external_agents: {
    claude: { enabled: true },
    dsh: { binaryPath: dsh, configHome: path.join(temporary, "dsh-home"), enabled: true },
  },
  pi: { enabled: true, binaryPath: path.join(fixture, "pi-rpc.mjs") },
  provider: {
    "backend-fixture": {
      npm: "@ai-sdk/openai-compatible",
      name: "Backend fixture",
      options: { apiKey: "fixture-only", baseURL: `${model.url}v1` },
      models: { fixture: { name: "Fixture", limit: { context: 100000, output: 10000 } } },
    },
  },
}
const env = {
  ...process.env,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_AUTH_CONTENT: "{}",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_TEST_HOME: path.join(temporary, "home"),
  OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(temporary, "managed"),
  XDG_CONFIG_HOME: path.join(temporary, "config"),
  XDG_DATA_HOME: path.join(temporary, "data"),
  XDG_CACHE_HOME: path.join(temporary, "cache"),
  XDG_STATE_HOME: path.join(temporary, "state"),
  CODEX_HOME: path.join(temporary, "codex-home"),
  CLAUDE_CONFIG_DIR: path.join(temporary, "claude-home"),
  PI_CODING_AGENT_DIR: path.join(temporary, "pi-home"),
}
const logfile = `${temporary}.log`
const output = createWriteStream(logfile)
const onboardingBefore = new Set(await readdir(tmpdir()))
if (desktop) {
  const targets = await listTargets(endpoint).catch(() => [])
  assert.equal(targets.length, 0, `Refusing to reuse or disrupt an existing app at ${endpoint}`)
}
const child = desktop
  ? spawn("bun", ["x", "--no-install", "electron-vite", "dev"], {
      cwd: path.join(root, "packages/desktop"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, OPENCODE_TEST_ONBOARDING: "1", OPENCODE_CDP_PORT: cdpPort, OPENCODE_RENDERER_PORT: "5183" },
    })
  : fork(
      path.join(import.meta.dir, "stability-sidecar-runner.mjs"),
      [pathToFileURL(path.join(root, "packages/desktop/out/main/sidecar.js")).href],
      { execPath: "node", cwd: workspace, stdio: ["ignore", "pipe", "pipe", "ipc"], env },
    )
child.stdout!.pipe(output, { end: false })
child.stderr!.pipe(output, { end: false })
let server: { url: string; password: string | null; username?: string | null }
let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined
const wait = async <T>(read: () => Promise<T | undefined>, label: string, timeout = 90000): Promise<T> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== undefined) return result
    if (child.exitCode !== null) throw new Error(`Desktop exited code=${child.exitCode}; logs=${logfile}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}; logs=${logfile}`)
}
const sessions: string[] = []
const logRoots = [temporary]
let collectedLogs = ""
try {
  if (desktop) {
    server = await wait(async () => {
      const candidate = await connectCdp(endpoint).catch(() => undefined)
      if (!candidate) return
      if (candidate.target.url.includes("loading.html")) {
        candidate.client.close()
        return
      }
      try {
        assert.ok(candidate.target.url.includes("localhost:5183"), `Unexpected CDP target ${candidate.target.url}`)
        const data = await candidate.client.evaluate<typeof server>("window.api.awaitInitialization(() => {})")
        cdp = candidate
        return data
      } catch {
        candidate.client.close()
        return
      }
    }, "initialized CDP renderer")
    log(`development Electron ready endpoint=${endpoint}`)
    for (const name of await readdir(tmpdir())) {
      if (name.startsWith("opencode-onboarding-") && !onboardingBefore.has(name))
        logRoots.push(path.join(tmpdir(), name))
    }
  } else {
    const password = crypto.randomUUID()
    const port = await new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as { port: number }).port
        probe.close(() => resolve(port))
      })
    })
    const ready = new Promise<void>((resolve, reject) => {
      child.on("message", (message: any) => {
        if (message.type === "booted")
          child.send!({ type: "start", hostname: "127.0.0.1", port, password, needsMigration: true })
        if (message.type === "ready") resolve()
        if (message.type === "error") reject(new Error(message.error.message))
      })
    })
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Sidecar startup timeout")), 30000)
        timer.unref()
      }),
    ])
    server = { url: `http://127.0.0.1:${port}`, password }
  }
  const request = async (route: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(`${server.url}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(workspace),
        Authorization: `Basic ${Buffer.from(`${server.username ?? "opencode"}:${server.password ?? ""}`).toString("base64")}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
    assert.ok(response.ok, `${method} ${route}: HTTP ${response.status} ${response.ok ? "" : await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  for (const [scenario, expected] of Object.entries(scenarios)) {
    const session = await request("/session", "POST", { title: `QA ${scenario}` })
    sessions.push(session.id)
    const result = await request(`/session/${session.id}/message`, "POST", {
      agent: "build",
      model: { providerID: "backend-fixture", modelID: "fixture" },
      parts: [{ type: "text", text: scenario }],
    })
    assert.ok(
      result.parts.some((part: any) => part.text === `${scenario}_OK`),
      JSON.stringify(result),
    )
    const history = await request(`/session/${session.id}/message`)
    const part = history.flatMap((item: any) => item.parts).find((item: any) => item.tool === expected.tool)
    assert.equal(part?.state.status, "completed", JSON.stringify(part))
    assert.equal(part.state.metadata.backend, expected.backend)
    const childID = part.state.metadata.externalSessionID
    assert.ok(childID)
    const messages = await request(`/session/${childID}/message`)
    assert.ok(messages.flatMap((item: any) => item.parts).some((item: any) => item.text?.includes(expected.answer)))
    assert.equal(messages.filter((item: any) => item.info.role === "user").length, 1)
    log(`PASS ${expected.backend} sent prompt, received reply and persisted child transcript`)
    if (cdp) {
      const route = `/${Buffer.from(workspace).toString("base64url")}/session/${childID}`
      if (scenario === "BACKEND_ACP")
        await wait(
          async () => {
            const text = await cdp!.client.evaluate<string>("document.body.innerText").catch(() => "")
            return text.includes("Open project") || text.includes("Read fixture") ? true : undefined
          },
          "mounted app router",
          30000,
        )
      // Desktop uses MemoryRouter; a normal anchor click reaches its navigation handler.
      await cdp.client.evaluate(`(() => {
        const link = document.createElement("a"); link.href = ${JSON.stringify(route)}; link.setAttribute("link", "");
        document.body.append(link); link.click(); link.remove(); return true;
      })()`)
      await wait(
        async () => {
          const text = await cdp!.client.evaluate<string>("document.body.innerText").catch(() => "")
          return text.includes(expected.answer) && !text.includes("Loading messages") ? true : undefined
        },
        `${expected.backend} child transcript UI`,
        30000,
      )
      const shot = await cdp.client.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
      await Bun.write(`${temporary}-${expected.backend}.png`, Buffer.from(shot.data, "base64"))
      log(`PASS ${expected.backend} child transcript visible in Electron via CDP`)
      if (scenario === "BACKEND_ACP") {
        const parentRoute = `/${Buffer.from(workspace).toString("base64url")}/session/${session.id}`
        await cdp.client.evaluate(`(() => {
          const link = document.createElement("a"); link.href = ${JSON.stringify(parentRoute)}; link.setAttribute("link", "");
          document.body.append(link); link.click(); link.remove(); return true;
        })()`)
        await wait(
          async () => {
            const ready = await cdp!.client
              .evaluate<boolean>(
                '!!document.querySelector(\'[data-component="prompt-input"][contenteditable="true"]\')',
              )
              .catch(() => false)
            return ready ? true : undefined
          },
          "parent composer",
          30000,
        )
        await cdp.client.evaluate(
          'document.querySelector(\'[data-component="prompt-input"][contenteditable="true"]\').focus(); true',
        )
        await cdp.client.call("Input.insertText", { text: "@" })
        await wait(
          async () => {
            const text = await cdp!.client.evaluate<string>("document.body.innerText")
            return text.includes("Claude (ACP)") ? true : undefined
          },
          "ACP mention menu",
          30000,
        )
        log("PASS configured ACP advisor appears in the parent composer @ menu")
      }
    }
  }
  if (cdp && installUI) {
    const navigate = async (route: string) =>
      cdp!.client.evaluate(`(() => {
      const link = document.createElement("a"); link.href = ${JSON.stringify(route)}; link.setAttribute("link", "");
      document.body.append(link); link.click(); link.remove(); return true;
    })()`)
    const click = async (label: string, advisor = "codex") => {
      const ok = await cdp!.client.evaluate<boolean>(`(() => {
        const panel = document.querySelector('[data-agent-backend="${advisor}"]');
        const button = [...(panel?.querySelectorAll('button') ?? [])].find(el => el.textContent.trim() === ${JSON.stringify(label)});
        if (!button || button.disabled) return false; button.click(); return true;
      })()`)
      assert.ok(ok, `Missing or disabled button ${label}`)
    }
    const panelText = (advisor = "codex") =>
      cdp!.client.evaluate<string>(`document.querySelector('[data-agent-backend="${advisor}"]')?.innerText ?? ""`)
    const chooseVersion = async (version: string) =>
      cdp!.client.evaluate(`(() => {
      const select = document.querySelector('[data-agent-backend="codex"] select[aria-label="Adapter version"]');
      select.value = ${JSON.stringify(version)}; select.dispatchEvent(new Event("change", {bubbles:true})); return true;
    })()`)
    await navigate("/config?section=claws&pick=claw:codex")
    await wait(async () => ((await panelText()).includes("Target machine") ? true : undefined), "ACP settings panel")
    await wait(
      async () => ((await request("/agent-backend")).adapters.length === 3 ? true : undefined),
      "adapter catalog",
    )
    await cdp.client.evaluate(`(() => {
      const select = document.querySelector('[data-agent-backend="codex"] select[aria-label="Transport"]');
      select.value = "acp"; select.dispatchEvent(new Event("change", {bubbles:true})); return true;
    })()`)
    await wait(
      async () =>
        (await panelText()).includes("Adapter version") && !(await panelText()).includes("Working") ? true : undefined,
      "managed version selector",
    )
    const reviewed = (await request("/agent-backend")).adapters.find((item: any) => item.advisor === "codex")
    const olderVersion = reviewed.releases.at(-1)
    await chooseVersion(olderVersion)
    await click("Install selected version")
    await wait(
      async () => ((await panelText()).includes("Confirm adapter operation") ? true : undefined),
      "install confirmation",
    )
    const before = await request("/agent-backend")
    assert.equal(before.adapters.find((item: any) => item.advisor === "codex").installed.length, 0)
    await click("Cancel")
    assert.equal(
      (await request("/agent-backend")).adapters.find((item: any) => item.advisor === "codex").installed.length,
      0,
    )
    await click("Install selected version")
    await wait(
      async () => ((await panelText()).includes("Confirm adapter operation") ? true : undefined),
      "second install confirmation",
    )
    await click("Confirm operation")
    await wait(
      async () => {
        const status = await request("/agent-backend")
        return status.adapters.find((item: any) => item.advisor === "codex").installed.length === 1 ? true : undefined
      },
      "real managed Codex adapter installation",
      300000,
    )
    await wait(
      async () =>
        (await panelText()).includes("Uninstall selected version") && !(await panelText()).includes("Working")
          ? true
          : undefined,
      "installation UI settled",
    )
    const configured = await request("/config")
    assert.notEqual(configured.agent_backends?.codex?.type, "acp", "Installation must not automatically enable ACP")
    log(
      "PASS install confirmation cancellation has no side effects; real pinned adapter installed only after confirmation",
    )
    await click("Update to recommended version")
    await wait(
      async () => ((await panelText()).includes("Confirm adapter operation") ? true : undefined),
      "reviewed update confirmation",
    )
    await click("Confirm operation")
    await wait(
      async () =>
        (await request("/agent-backend")).adapters.find((item: any) => item.advisor === "codex").installed.length === 2
          ? true
          : undefined,
      "side-by-side update",
      300000,
    )
    await wait(async () => (!(await panelText()).includes("Working") ? true : undefined), "update settled")
    await chooseVersion(olderVersion)
    await click("Test connection (no model prompt)")
    await wait(
      async () => {
        const text = await panelText()
        return (text.includes("Login required") || text.includes("Connected (handshake passed)")) &&
          !text.includes("Working")
          ? true
          : undefined
      },
      "real ACP session/authentication probe",
      60000,
    )
    const shot = await cdp.client.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write(`${temporary}-installation.png`, Buffer.from(shot.data, "base64"))
    await click("Uninstall selected version")
    await wait(
      async () => ((await panelText()).includes("Confirm adapter operation") ? true : undefined),
      "uninstall confirmation",
    )
    await click("Confirm operation")
    await wait(
      async () =>
        (await request("/agent-backend")).adapters.find((item: any) => item.advisor === "codex").installed.length === 1
          ? true
          : undefined,
      "managed adapter removal",
    )
    await wait(async () => (!(await panelText()).includes("Working") ? true : undefined), "old version removal settled")
    await chooseVersion(reviewed.recommended)
    await click("Uninstall selected version")
    await wait(
      async () => ((await panelText()).includes("Confirm adapter operation") ? true : undefined),
      "recommended version removal confirmation",
    )
    await click("Confirm operation")
    await wait(
      async () =>
        (await request("/agent-backend")).adapters.find((item: any) => item.advisor === "codex").installed.length === 0
          ? true
          : undefined,
      "all managed test versions removed",
    )
    log(
      "PASS reviewed update retains the previous version; rollback selection/probe and separate removals preserve isolation",
    )
    log("PASS real adapter probe distinguishes authentication; UI uninstall removes only the managed version")
    // Test and activate the existing fixture command through the same configuration UI.
    await navigate("/config?section=claws&pick=claw:claude")
    await wait(
      async () =>
        (await panelText("claude")).includes("Transport") && !(await panelText("claude")).includes("Working")
          ? true
          : undefined,
      "custom advisor panel",
    )
    await cdp.client.evaluate(`(() => {
      const panel = document.querySelector('[data-agent-backend="claude"]');
      const transport = panel.querySelector('select[aria-label="Transport"]'); transport.value = "acp"; transport.dispatchEvent(new Event("change", {bubbles:true}));
      const source = panel.querySelector('select[aria-label="ACP installation"]'); source.value = "custom"; source.dispatchEvent(new Event("change", {bubbles:true}));
      const command = panel.querySelector('textarea'); command.value = ${JSON.stringify(JSON.stringify(["node", path.join(fixture, "acp-agent.mjs")]))}; command.dispatchEvent(new Event("input", {bubbles:true}));
      return true;
    })()`)
    await wait(
      async () =>
        (await panelText("claude")).includes("Test connection") && !(await panelText("claude")).includes("Working")
          ? true
          : undefined,
      "custom ACP settings",
    )
    await click("Test connection (no model prompt)", "claude")
    await wait(
      async () => ((await panelText("claude")).includes("Connected (handshake passed)") ? true : undefined),
      "custom ACP connection test",
    )
    await click("Test message", "claude")
    await wait(
      async () => ((await panelText("claude")).includes("may incur model charges") ? true : undefined),
      "message test consent",
    )
    await click("Send test message", "claude")
    await wait(
      async () =>
        (await panelText("claude")).includes("ACP_REPLY_1") && !(await panelText("claude")).includes("Working")
          ? true
          : undefined,
      "explicit fixture test message",
    )
    await click("Save and enable backend", "claude")
    await wait(
      async () => ((await panelText("claude")).includes("Backend configuration saved") ? true : undefined),
      "tested ACP configuration saved",
    )
    assert.equal((await request("/global/config")).agent_backends.claude.type, "acp")
    log(
      "PASS custom command handshake, explicit message consent, reply verification and save/enable through configuration UI",
    )
  }
  const readLogs = async (directory: string): Promise<string> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    return (
      await Promise.all(
        entries.map((entry) => {
          const file = path.join(directory, entry.name)
          if (entry.isDirectory()) return readLogs(file)
          return entry.name.endsWith(".log") ? readFile(file, "utf8") : ""
        }),
      )
    ).join("\n")
  }
  collectedLogs = (await Promise.all(logRoots.map(readLogs))).join("\n")
  const logs = (await readFile(logfile, "utf8")) + collectedLogs
  for (const expected of Object.values(scenarios)) assert.ok(logs.includes(`backend=${expected.backend}`))
  assert.ok(logs.includes("ready session=acp-fixture-"))
  assert.ok(logs.includes("handoff ready"))
  log("PASS backend logs inspected: routing, ACP handshake and conversation handoff confirmed")
} finally {
  if (cdp) {
    // Quit only the isolated dev app that this script launched.
    await cdp.client.evaluate("window.close(); true").catch(() => {})
    cdp.client.close()
  }
  child.kill("SIGTERM")
  model.stop(true)
  if (child.exitCode === null)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve()
      }, 5000)
      child.once("close", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  child.stdout?.unpipe(output)
  child.stderr?.unpipe(output)
  await new Promise<void>((resolve) => output.end(resolve))
  if (collectedLogs) await appendFile(logfile, `\n--- Collected backend logs ---\n${collectedLogs}`)
  await rm(temporary, { recursive: true, force: true })
  log(`retained diagnostics=${logfile}; screenshots=${temporary}-*.png`)
}
