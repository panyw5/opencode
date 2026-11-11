import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("extension installation contracts pass in an isolated Solid JSX process", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/fixtures/extension-install.contract.ts",
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill(), 20_000)
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) console.error(`[extension-install-test] code=${code}\n${out}\n${err}`)
    expect(code).toBe(0)
    expect(`${out}\n${err}`).toContain("20 pass")
  } finally {
    clearTimeout(timer)
  }
}, 25_000)
