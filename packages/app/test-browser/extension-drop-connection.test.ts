import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("extension archive drop connection changes pass in an isolated Solid process", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/fixtures/extension-drop-connection.contract.ts",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => child.kill(), 20_000)
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) console.error(`[extension-drop-test] code=${code}\n${out}\n${err}`)
    expect(code).toBe(0)
  } finally {
    clearTimeout(timer)
  }
}, 25_000)
