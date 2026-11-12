import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { extensionFromStack } from "./sidecar-error"

describe("sidecar extension stack attribution", () => {
  test("extracts the sanitized extension cache directory from a V8 frame", () => {
    const stack = [
      "Error: timer exploded",
      "    at tick (/tmp/opencode/extension-modules/acme.example/v1/dist/server.js:12:3)",
      "    at processTicksAndRejections (node:internal/process/task_queues:105:5)",
    ].join("\n")
    expect(extensionFromStack(stack)).toBe("acme.example")
  })

  test("supports file URLs, Windows paths and sanitized IDs", () => {
    expect(extensionFromStack("Error\n    at file:///tmp/extension-modules/acme_example/abc/server.js:1:1")).toBe(
      "acme_example",
    )
    expect(
      extensionFromStack("Error\n    at tick (C:\\cache\\extension-modules\\acme.example\\abc\\server.js:2:1)"),
    ).toBe("acme.example")
    expect(extensionFromStack("Error\n    at /tmp/extension-modules/_/abc/server.js:1:1")).toBe("_")
    expect(extensionFromStack(`Error\n    at /tmp/extension-modules/${"a".repeat(120)}/abc/server.js:1:1`)).toBe(
      "a".repeat(120),
    )
  })

  test("uses the nearest matching stack frame, not an ID mentioned in the error message", () => {
    expect(
      extensionFromStack(
        [
          "Error: /tmp/extension-modules/unrelated/abc/server.js",
          "    at tick (/tmp/extension-modules/acme.first/abc/server.js:1:1)",
          "    at run (/tmp/extension-modules/acme.second/abc/server.js:1:1)",
        ].join("\n"),
      ),
    ).toBe("acme.first")
    expect(extensionFromStack("Error: /tmp/extension-modules/unrelated/abc/server.js")).toBeUndefined()
  })

  test("does not attribute ordinary sidecar failures", () => {
    expect(extensionFromStack()).toBeUndefined()
    expect(extensionFromStack("")).toBeUndefined()
    expect(extensionFromStack("Error: boom\n    at tick (/app/sidecar.js:1:1)")).toBeUndefined()
    expect(
      extensionFromStack("Error\n    at /tmp/not-extension-modules/acme.example/abc/server.js:1:1"),
    ).toBeUndefined()
  })

  test("uncaught extension timer errors remain fatal with exit code 1", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `
        import { mock } from "bun:test"
        mock.module("effect", () => ({ Effect: {}, Layer: {} }))
        process.parentPort = {
          postMessage(message) { console.log(JSON.stringify(message)) },
          on() {},
        }
        await import(${JSON.stringify(fileURLToPath(new URL("./sidecar.ts", import.meta.url)))})
        setTimeout(() => {
          const error = new Error("fatal sentinel")
          error.stack = "Error: fatal sentinel\\n    at tick (/tmp/extension-modules/acme.example/hash/server.js:1:1)"
          throw error
        }, 0)
      `,
      ],
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(1)
    const message = JSON.parse(stdout.trim())
    expect(message.type).toBe("error")
    expect(message.error.message).toContain("sidecar uncaughtException [extension=acme.example]")
    expect(message.error.stack).toContain("fatal sentinel")
    expect(stderr).toContain("sidecar uncaughtException [extension=acme.example]")
  })

  test.each([".", "..", "", "acme%2Eexample", "acme example", "a".repeat(121)])(
    "rejects invalid sanitized cache segments: %s",
    (id) => {
      expect(extensionFromStack(`Error\n    at /tmp/extension-modules/${id}/abc/server.js:1:1`)).toBeUndefined()
    },
  )
})
