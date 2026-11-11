import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

// Both mock.module and the Solid JSX loader belong to this child process only.
test("agent backend settings contracts pass in an isolated Solid JSX process", async () => {
  const directory = fileURLToPath(new URL("..", import.meta.url))
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/fixtures/agent-backend-settings.contract.ts",
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
    if (code !== 0) console.error(`[agent-backend-settings-test] child failed code=${code}\n${stdout}\n${stderr}`)
    expect(code).toBe(0)
    // A green exit without collecting the contract must not pass the wrapper.
    expect(`${stdout}\n${stderr}`).toContain("31 pass")
    expect(`${stdout}\n${stderr}`).toContain("0 fail")
  } finally {
    clearTimeout(timer)
  }
}, 25_000)
