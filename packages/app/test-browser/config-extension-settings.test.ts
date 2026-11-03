import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

// Keep the Solid JSX transform out of other browser tests' module registry.
test("extension config form contracts pass in an isolated Solid JSX process", async () => {
  const directory = fileURLToPath(new URL("..", import.meta.url))
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/fixtures/config-extension-settings.contract.ts",
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
    if (code !== 0) console.error(`[config-form-test] child failed code=${code}\n${stdout}\n${stderr}`)
    expect(code).toBe(0)
    expect(`${stdout}\n${stderr}`).toContain("10 pass")
  } finally {
    clearTimeout(timer)
  }
}, 25_000)
