import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { controlFdSourceFile } from "../../../src/extension/host-process/transport-bun.ts"
import { spawnWorkerTransport } from "../../../src/extension/host-process/transport.ts"
import { fdOwnerFixture, testIdentity } from "./fixture.ts"

// Regression for the Bun extra-fd double-close: a GC'd native Subprocess must
// not close an fd number a newer worker already owns (Darwin adapter only).
const run = test.skipIf(!process.versions.bun || process.platform !== "darwin")

run("recycling exited subprocesses cannot close a newer worker's control descriptors", async () => {
  const rounds = Number(process.env.OPENCODE_HOST_PROCESS_FD_ROUNDS ?? 60)
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 500) throw new RangeError("FD rounds must be 1–500")
  for (let round = 0; round < rounds; round++) {
    const identity = testIdentity()
    const diagnostics: string[] = []
    await using transport = await spawnWorkerTransport({
      executable: process.execPath,
      args: [fdOwnerFixture, JSON.stringify(identity)],
      frameBytes: 4096,
      bufferedFrames: 4,
      exitMs: 2000,
      log: (stream, text) => diagnostics.push(`${stream}: ${text}`),
    })
    let ready!: () => void
    let replied!: () => void
    let failed!: (error: Error) => void
    const hello = new Promise<void>((resolve, reject) => {
      ready = resolve
      failed = reject
    })
    const reply = new Promise<void>((resolve) => {
      replied = resolve
    })
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
      await Promise.race([
        reply,
        transport.exited.then(() => {
          throw new Error(`Control lost round=${round} ${diagnostics.join(" | ")}`)
        }),
      ])
      expect(await transport.exited).toEqual({ code: 0, signal: null })
      await transport.release()
      await transport.release()
    } finally {
      clearTimeout(deadline)
      off()
    }
  }
}, 30_000)

// The FFI source must live on the real filesystem: inside a compiled binary
// `import.meta.url` resolves to `/$bunfs/…`, which Bun's patched fs accepts
// but the embedded compiler cannot open (T5.4 packaging regression).
test("controlFdSourceFile materializes the embedded source on the real filesystem", () => {
  const file = controlFdSourceFile()
  expect(file.includes("$bunfs")).toBe(false)
  expect(existsSync(file)).toBe(true)
  const source = readFileSync(file, "utf8")
  expect(source).toContain("duplicate_control_fd")
  expect(source).toContain("F_DUPFD_CLOEXEC")
  // Idempotent across calls.
  expect(controlFdSourceFile()).toBe(file)
})
