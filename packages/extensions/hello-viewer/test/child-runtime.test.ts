import { describe, expect, test } from "bun:test"
import { resolveChildRuntime } from "../src/child-runtime"

describe("hello-viewer child runtime", () => {
  test("uses the current JS runtime in source mode", () => {
    expect(resolveChildRuntime({ execPath: "/usr/local/bin/bun", env: {} })).toBe("/usr/local/bin/bun")
    expect(resolveChildRuntime({ execPath: "/usr/local/bin/node", env: {} })).toBe("/usr/local/bin/node")
  })

  test("does not re-exec a compiled opencode binary as JavaScript", () => {
    const found: string[] = []
    const runtime = resolveChildRuntime({
      execPath: "/tmp/build/bin/opencode",
      env: {},
      find(name) {
        found.push(name)
        return name === "node" ? "/usr/bin/node" : undefined
      },
    })
    expect(runtime).toBe("/usr/bin/node")
    expect(found).toEqual(["bun", "node"])
  })

  test("accepts an explicit runtime executable before PATH", () => {
    expect(
      resolveChildRuntime({
        execPath: "/tmp/build/bin/opencode",
        env: { OPENCODE_JS_RUNTIME: "/custom/bun" },
        find: () => {
          throw new Error("should not search PATH")
        },
      }),
    ).toBe("/custom/bun")
  })

  test("fails fast with a useful error when neither runtime is installed", () => {
    expect(() => resolveChildRuntime({ execPath: "/tmp/build/bin/opencode", env: {}, find: () => undefined })).toThrow(
      "OPENCODE_JS_RUNTIME",
    )
  })
})
