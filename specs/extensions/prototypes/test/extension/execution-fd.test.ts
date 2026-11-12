import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { spawnExecutionProcess } from "../../src/extension/execution-process"
import { executionIdentity } from "./execution-fixture"

const fixture = fileURLToPath(new URL("./fixtures/fd-owner.mjs", import.meta.url))

test("recycling exited subprocesses cannot close a newer execution's control descriptors", async () => {
  for (let round = 0; round < 60; round++) {
    const { identity } = executionIdentity()
    const diagnostics: string[] = []
    await using transport = await spawnExecutionProcess({
      executable: process.execPath,
      args: [fixture, JSON.stringify(identity)],
      frameBytes: 4096,
      bufferedFrames: 4,
      exitMs: 2000,
      log: (stream, text) => diagnostics.push(`${stream}: ${text}`),
    })
    let ready!: () => void
    let replied!: () => void
    let failed!: (error: Error) => void
    const hello = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
    const reply = new Promise<void>((resolve) => { replied = resolve })
    const off = transport.subscribe((value) => {
      const event = value as { type: string }
      if (event.type === "hello") ready()
      if (event.type === "drained") replied()
    }, failed)
    const deadline = setTimeout(() => {
      failed(new Error(`Control deadline round=${round} ${diagnostics.join(" | ")}`))
      transport.terminate()
    }, 2000)
    try {
      await hello
      // Reclaim older subprocess wrappers while these newly allocated fds are live.
      Bun.gc(true)
      transport.send({ version: 1, identity, type: "drain" })
      await Promise.race([reply, transport.exited.then(() => { throw new Error(`Control lost round=${round} ${diagnostics.join(" | ")}`) })])
      expect(await transport.exited).toEqual({ code: 0, signal: null })
      await transport.release()
      await transport.release()
    } finally {
      clearTimeout(deadline)
      off()
    }
  }
}, 30000)
