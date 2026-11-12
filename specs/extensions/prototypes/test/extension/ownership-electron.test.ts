import { expect, test } from "bun:test"
import { lstat, mkdir, symlink } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tryAcquireOwnership } from "../../src/extension/ownership"
import { fixtureProcess } from "./lifecycle-process"
import { ownershipStorage, ownershipWorker } from "./ownership-fixture"

const enabled = process.env.OPENCODE_EXTENSION_ELECTRON_PROBE === "1"
const electronTest = test.skipIf(!enabled || process.platform !== "darwin")
const main = fileURLToPath(new URL("../../scripts/extension-lifecycle/main.cjs", import.meta.url))
const prototypeRequire = createRequire(new URL("../../package.json", import.meta.url))

async function probe(root: string, file: string, mode: "shared" | "exclusive") {
  const executable: unknown = prototypeRequire("electron")
  if (typeof executable !== "string") throw new Error("Electron package did not resolve its executable")
  const output = path.join(root, "ownership-worker.mjs")
  const result = await Bun.build({
    entrypoints: [ownershipWorker],
    target: "node",
    format: "esm",
    external: ["bun:ffi"],
  })
  if (!result.success) throw new AggregateError(result.logs, "Ownership utility bundle failed")
  if (result.outputs.length !== 1) throw new Error("Expected one ownership utility bundle")
  await Bun.write(output, result.outputs[0]!)
  await mkdir(path.join(root, "node_modules"), { mode: 0o700 })
  await symlink(
    path.dirname(fileURLToPath(import.meta.resolve("fs-native-extensions/package.json"))),
    path.join(root, "node_modules", "fs-native-extensions"),
    "dir",
  )
  await mkdir(path.join(root, "electron-user-data"), { mode: 0o700 })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return fixtureProcess(
    executable,
    [
      main,
      `--user-data-dir=${path.join(root, "electron-user-data")}`,
      `--probe-root=${root}`,
      `--probe-worker=${output}`,
      `--probe-file=${file}`,
      `--probe-mode=${mode}`,
    ],
    env,
  )
}

electronTest(
  "actual Electron utility process holds ownership and releases it after forced exit",
  async () => {
    await using f = await ownershipStorage()
    await using owner = await probe(f.root, f.file, "exclusive")
    const acquired = await owner.wait("acquired")
    expect(acquired.runtime).toBe("electron")
    expect(acquired.pid).not.toBe(process.pid)
    const before = await lstat(f.file)
    expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
    expect(await tryAcquireOwnership(f.file, "shared")).toEqual({ status: "busy" })
    owner.send({ type: "assert" })
    await owner.wait("held")
    owner.send({ type: "crash" })
    const gone = await owner.wait("utility-exit")
    expect(gone.pid).toBe(acquired.pid)
    expect(gone.exitCode).not.toBe(0)
    expect(await owner.closed()).toEqual({ code: 0, signal: null })
    const result = await tryAcquireOwnership(f.file, "exclusive")
    expect(result.status).toBe("acquired")
    if (result.status !== "acquired") throw new Error("Exited utility still blocks ownership")
    await using lease = result.lease
    await lease.assertHeld()
    const after = await lstat(f.file)
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
  },
  30_000,
)

electronTest(
  "loss of the probe control channel stops its utility before the guard is reusable",
  async () => {
    await using f = await ownershipStorage()
    await using owner = await probe(f.root, f.file, "exclusive")
    await owner.wait("acquired")
    owner.disconnect()
    expect(await owner.closed()).toEqual({ code: 1, signal: null })
    const result = await tryAcquireOwnership(f.file, "exclusive")
    if (result.status !== "acquired") throw new Error("Disconnected utility still holds ownership")
    await using lease = result.lease
    await lease.assertHeld()
  },
  30_000,
)

electronTest(
  "Bun and actual Electron utility share readers and exclude a writer until both release",
  async () => {
    await using f = await ownershipStorage()
    const first = await tryAcquireOwnership(f.file, "shared")
    if (first.status !== "acquired") throw new Error("Missing Bun reader")
    await using reader = first.lease
    await using owner = await probe(f.root, f.file, "shared")
    expect((await owner.wait("acquired")).runtime).toBe("electron")
    owner.send({ type: "touch" })
    await owner.wait("touched")
    expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
    await reader.release()
    expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
    owner.send({ type: "release" })
    await owner.wait("released")
    const result = await tryAcquireOwnership(f.file, "exclusive")
    if (result.status !== "acquired") throw new Error("Released readers blocked writer")
    await using writer = result.lease
    owner.send({ type: "acquire" })
    await owner.wait("busy")
    await writer.release()
    owner.send({ type: "acquire" })
    await owner.wait("acquired")
    owner.send({ type: "exit" })
    expect((await owner.wait("utility-exit")).exitCode).toBe(0)
    expect(await owner.closed()).toEqual({ code: 0, signal: null })
  },
  30_000,
)
