import { expect, test } from "bun:test"
import { GptProLoginServer } from "./gpt-pro-login-server"
import { launchGptProLogin } from "./gpt-pro-login-launcher"

test("opening the connection page never attempts cookie replacement, even with an unfinished consultation", async () => {
  const logs: string[] = []
  const opened: string[] = []
  let imports = 0
  const login = new GptProLoginServer({
    extensionDirectory: "/tmp/extension", log: (message) => logs.push(message),
    importCookies: async () => { imports++; throw Error("login_import_busy: unfinished consultation") },
    imported: async () => { throw Error("Opening a connection must not import") },
  })
  try {
    const result = await launchGptProLogin(login, async (url) => { opened.push(url) }, (message) => logs.push(message))
    expect(result.phase).toBe("waiting")
    expect(opened).toHaveLength(1)
    expect(new URL(opened[0]).hostname).toBe("127.0.0.1")
    expect(new URL(opened[0]).hash).toMatch(/^#token=[a-f0-9]{64}$/)
    expect(imports).toBe(0)
    expect(logs.join("\n")).not.toContain(opened[0])
    expect(logs.join("\n")).not.toContain(new URL(opened[0]).hash.slice(7))
    await launchGptProLogin(login, async (url) => { opened.push(url) }, (message) => logs.push(message))
    expect(opened[1]).toBe(opened[0])
  } finally { login.cancel() }
})

test("default-browser failure cancels only the connection and reports a browser launch error", async () => {
  const logs: string[] = []
  const login = new GptProLoginServer({ extensionDirectory: "/tmp/extension", log: (line) => logs.push(line),
    importCookies: async () => { throw Error("Must not import") }, imported: async () => {} })
  try {
    await expect(launchGptProLogin(login, async (url) => { throw Error(`Private URL ${url}`) }, (line) => logs.push(line)))
      .rejects.toThrow("browser_open_failed")
    expect(login.status().phase).toBe("cancelled")
    expect(logs.join("\n")).not.toContain("#token=")
    expect(logs.join("\n")).not.toContain("Private URL")
  } finally { login.cancel() }
})

test("local-server failure is not mislabeled as a ChatGPT login failure", async () => {
  const login = { start: async () => { throw Error("EADDRNOTAVAIL") }, status: () => ({ phase: "idle" as const }), cancel: () => ({ phase: "cancelled" as const }) }
  let opened = false
  await expect(launchGptProLogin(login, async () => { opened = true }, () => {})).rejects.toThrow("login_connection_failed")
  expect(opened).toBe(false)
})
