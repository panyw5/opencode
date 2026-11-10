import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

// Keep context mocks and the Solid JSX loader out of the shared test process.
test("agent settings layout contracts pass in an isolated Solid JSX process", async () => {
  const directory = fileURLToPath(new URL("..", import.meta.url))
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/fixtures/agent-settings-layout.contract.ts",
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill(), 20_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const output = `${stdout}\n${stderr}`
    if (code !== 0) console.error(`[agent-settings-layout-test] child failed code=${code}\n${output}`)
    expect(code).toBe(0)
    // An empty discovery must not silently turn this wrapper green.
    expect(output).toContain("6 pass")
    expect(output).toContain("0 fail")
  } finally {
    clearTimeout(timer)
  }
}, 25_000)
