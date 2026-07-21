import { describe, expect, test } from "bun:test"

import { deployCli } from "./cli-deploy"

const source = "/bundle/opencode.exe"
const target = "/bin/opencode.exe"
const temp = "/bin/.opencode.exe.staged.tmp"

function operations(input: { rename: () => Promise<void> | void }) {
  const calls: string[] = []
  return {
    calls,
    operations: {
      copyFile: async (from: string, to: string) => {
        calls.push(`copy:${from}:${to}`)
      },
      rename: async (from: string, to: string) => {
        calls.push(`rename:${from}:${to}`)
        await input.rename()
      },
      rm: async (path: string) => {
        calls.push(`rm:${path}`)
      },
      sleep: async (milliseconds: number) => {
        calls.push(`sleep:${milliseconds}`)
      },
      createTempPath: () => temp,
    },
  }
}

describe("deployCli", () => {
  test("stages a replacement beside the target before publishing it", async () => {
    const mock = operations({ rename: () => undefined })

    await expect(deployCli({ source, target, operations: mock.operations })).resolves.toBe(target)
    expect(mock.calls).toEqual([`copy:${source}:${temp}`, `rename:${temp}:${target}`, `rm:${temp}`])
  })

  test("retries a Windows executable replacement while the old CLI is locked", async () => {
    let calls = 0
    const mock = operations({
      rename: () => {
        calls++
        if (calls < 3) throw Object.assign(new Error("busy"), { code: "EPERM" })
      },
    })

    await expect(deployCli({ source, target, platform: "win32", retryDelayMs: 1, operations: mock.operations })).resolves.toBe(target)
    expect(mock.calls).toEqual([
      `copy:${source}:${temp}`,
      `rename:${temp}:${target}`,
      "sleep:1",
      `rename:${temp}:${target}`,
      "sleep:1",
      `rename:${temp}:${target}`,
      `rm:${temp}`,
    ])
  })

  test("reports a locked destination after the bounded Windows retry budget", async () => {
    const mock = operations({
      rename: () => {
        throw Object.assign(new Error("access denied"), { code: "EACCES" })
      },
    })

    await expect(deployCli({ source, target, platform: "win32", attempts: 2, retryDelayMs: 1, operations: mock.operations })).rejects.toThrow(
      "Could not update OpenCode CLI at /bin/opencode.exe: the destination executable may still be running. Close opencode.exe and retry. access denied",
    )
    expect(mock.calls.at(-1)).toBe(`rm:${temp}`)
  })

  test("does not retry unrelated replacement errors", async () => {
    const mock = operations({
      rename: () => {
        throw Object.assign(new Error("invalid path"), { code: "ENOENT" })
      },
    })

    await expect(deployCli({ source, target, platform: "win32", operations: mock.operations })).rejects.toThrow("Could not install OpenCode CLI")
    expect(mock.calls.filter((call) => call.startsWith("rename:"))).toHaveLength(1)
  })
})
