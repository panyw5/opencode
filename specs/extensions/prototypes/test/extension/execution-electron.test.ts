import { expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tryAcquireOwnership } from "../../src/extension/ownership"
import { executionIdentity } from "./execution-fixture"
import { fixtureProcess } from "./lifecycle-process"
import { ownershipStorage } from "./ownership-fixture"

const electronTest = test.skipIf(process.env.OPENCODE_EXTENSION_ELECTRON_PROBE !== "1" || process.platform !== "darwin")
const prototypeRequire = createRequire(new URL("../../package.json", import.meta.url))
const main = fileURLToPath(new URL("../../scripts/extension-lifecycle/supervisor.cjs", import.meta.url))

async function probe(root: string, guard: string, behavior: string) {
  const executable: unknown = prototypeRequire("electron")
  if (typeof executable !== "string") throw new Error("Electron executable is unavailable")
  for (const name of ["execution-worker", "electron-supervisor"]) {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url))],
      target: "node",
      format: "esm",
      external: ["electron", "bun:ffi", "effect"],
    })
    if (!result.success || result.outputs.length !== 1)
      throw new AggregateError(result.logs, "Execution probe bundle failed")
    await Bun.write(path.join(root, `${name}.mjs`), result.outputs[0]!)
  }
  await mkdir(path.join(root, "node_modules"), { mode: 0o700 })
  for (const name of ["fs-native-extensions", "effect"]) {
    await symlink(
      path.dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`))),
      path.join(root, "node_modules", name),
      "dir",
    )
  }
  await mkdir(path.join(root, "electron-user-data"), { mode: 0o700 })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return fixtureProcess(
    executable,
    [
      main,
      `--user-data-dir=${path.join(root, "electron-user-data")}`,
      `--probe-root=${root}`,
      `--probe-worker=${path.join(root, "execution-worker.mjs")}`,
      `--probe-runner=${path.join(root, "electron-supervisor.mjs")}`,
      `--probe-identity=${JSON.stringify(executionIdentity().identity)}`,
      `--probe-guard=${guard}`,
      `--probe-behavior=${behavior}`,
    ],
    env,
  )
}

for (const behavior of ["normal", "disposeThrow", "disposeHang"] as const)
  electronTest(
    `actual Electron supervisor: ${behavior} completes JSON traffic and observes utility exit before releasing the reference`,
    async () => {
      await using f = await ownershipStorage()
      await using owner = await probe(f.root, f.file, behavior)
      await owner.wait("supervisor-ready")
      expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
      owner.send({ type: "request" })
      expect((await owner.wait("reply")).message).toBe("electron echo")
      owner.send({ type: "dispose" })
      const result = await owner.wait("supervisor-stopped")
      expect(result.message).toBe("unproven")
      if (behavior === "normal") {
        expect(result.code).toBe("")
        expect(result.exitCode).toBe(0)
      } else expect(result.code).toContain(behavior === "disposeThrow" ? "disposeFailed" : "disposeDeadline")
      const closed = await owner.closed()
      if (process.env.OPENCODE_EXTENSION_LIFECYCLE_TRACE === "1") console.info(owner.diagnostics())
      expect(closed).toEqual({ code: 0, signal: null })
      const acquired = await tryAcquireOwnership(f.file, "exclusive")
      if (acquired.status !== "acquired") throw new Error("Exited utility still holds its reference")
      await using lease = acquired.lease
      await lease.assertHeld()
    },
    30_000,
  )

electronTest(
  "actual Electron supervisor: activation failure never opens request admission",
  async () => {
    await using f = await ownershipStorage()
    await using owner = await probe(f.root, f.file, "loadThrow")
    const rejected = await owner.wait("readiness-rejected")
    if (rejected.code === undefined) throw new Error("Readiness rejection omitted its code")
    expect(["readiness", "exited"]).toContain(rejected.code)
    const closed = await owner.closed()
    if (process.env.OPENCODE_EXTENSION_LIFECYCLE_TRACE === "1") console.info(owner.diagnostics())
    expect(closed).toEqual({ code: 0, signal: null })
    const acquired = await tryAcquireOwnership(f.file, "exclusive")
    if (acquired.status !== "acquired") throw new Error("Failed utility still holds its reference")
    await using lease = acquired.lease
    await lease.assertHeld()
  },
  30_000,
)
