import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { pathToFileURL } from "node:url"
import { ExtensionLeases as Leases } from "../../src/extension/leases"

const native = process.platform === "darwin" || process.platform === "linux"
const node = Bun.which("node")
const roots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
const held: Leases.Lease[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise((resolve) => child.once("exit", resolve))
      child.kill("SIGKILL")
      await exit
    }
  }
  await Promise.all(held.splice(0).map((lease) => lease.release()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "extension-leases-")))
  roots.push(root)
  return { root, registry: path.join(root, "registry.json"), id: randomUUID() }
}
async function acquire(registry: string, id: string) {
  const lease = await Leases.acquire(registry, id)
  held.push(lease)
  return lease
}
async function lockFile(root: string, id: string, namespace = "ref") {
  const directory = path.join(root, namespace, id)
  const name = (await readdir(directory)).find((entry) => entry.endsWith(".lock"))
  expect(name).toBeDefined()
  return path.join(directory, name!)
}
async function worker(registry: string, id: string, runtime = process.execPath) {
  const source = `import {ExtensionLeases as L} from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../../src/extension/leases.ts")).href)};
const lease=await L.acquire(${JSON.stringify(registry)},${JSON.stringify(id)});
console.log(JSON.stringify({ready:true,proof:lease.proof}));
process.stdin.once('data',async()=>{await lease.release();console.log('released');process.exit(0)});
setInterval(()=>{},10000);`
  const child = spawn(
    runtime,
    [...(runtime === node ? ["--experimental-transform-types", "--input-type=module"] : []), "--eval", source],
    { stdio: ["pipe", "pipe", "pipe"] },
  )
  children.push(child)
  let output = ""
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  const ready = await new Promise<{ ready: true; proof: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Lease worker readiness timeout: ${stderr}`)), 10000)
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
      if (!output.includes("\n")) return
      clearTimeout(timer)
      try {
        resolve(JSON.parse(output.split("\n")[0]!))
      } catch (error) {
        reject(error)
      }
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`Lease worker exited ${code}: ${stderr}`))
    })
  })
  return { child, ready }
}
async function stop(child: ChildProcessWithoutNullStreams, crash = false) {
  const exit = new Promise((resolve) => child.once("exit", resolve))
  if (crash) child.kill("SIGKILL")
  else child.stdin.write("release\n")
  await exit
}

// No registry, real user configuration, network, shell flock command, heartbeat or PID liveness check is used.
describe("extension generation leases", () => {
  test("strict identity validation never creates request-controlled paths", async () => {
    const { registry, root } = await fixture()
    for (const id of [
      "../outside",
      "../../tmp/x",
      "a".repeat(36),
      "00000000-0000-0000-0000-000000000000/child",
      "AABBCCDD-0000-0000-0000-000000000000",
    ]) {
      await expect(Leases.acquire(registry, id)).rejects.toMatchObject({ name: "ExtensionLeaseError", code: "invalid" })
      expect(
        (
          await Leases.withExclusiveGeneration(registry, id, async () => {
            throw new Error("must not run")
          })
        ).status,
      ).toBe("busy")
    }
    expect(await readdir(root)).toEqual([])
  })

  test("a missing or uninitialized reference is busy, not dead", async () => {
    const { registry, id, root } = await fixture()
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
    await mkdir(path.join(root, "ref", id), { recursive: true })
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
  })

  test.skipIf(!native)("refcounts the same generation, releases idempotently, and keeps stable inodes", async () => {
    const { registry, id, root } = await fixture()
    const first = await acquire(registry, id)
    const second = await acquire(registry, id)
    expect(first.proof).toBe("flock")
    const file = await lockFile(root, id)
    const before = await stat(file)
    expect(await Leases.list(registry, id)).toMatchObject({ status: "live", leases: [expect.any(String)] })
    await first.release()
    await first.release()
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
    await second.release()
    expect(await Leases.withExclusiveGeneration(registry, id, async () => "done")).toEqual({
      status: "collected",
      value: "done",
    })
    const third = await acquire(registry, id)
    expect((await stat(file)).ino).toBe(before.ino)
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
    await third.release()
    expect(await Leases.list(registry, id)).toEqual({ status: "idle", leases: [] })
  })

  test.skipIf(!native)("old timestamps never turn a live process into a stale lease", async () => {
    const { registry, id, root } = await fixture()
    await acquire(registry, id)
    const file = await lockFile(root, id)
    await utimes(file, new Date(0), new Date(0))
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
    expect((await Leases.list(registry, id)).status).toBe("live")
  })

  test.skipIf(!native)("a collector excludes new acquires and other collectors throughout its callback", async () => {
    const { registry, id } = await fixture()
    await (await acquire(registry, id)).release()
    let enter!: () => void
    let leave!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      leave = resolve
    })
    const collecting = Leases.withExclusiveGeneration(registry, id, async () => {
      enter()
      await blocked
      return 9
    })
    await entered
    let acquired = false
    const pending = acquire(registry, id).then((value) => {
      acquired = true
      return value
    })
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 0)).status).toBe("busy")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(acquired).toBe(false)
    leave()
    expect(await collecting).toEqual({ status: "collected", value: 9 })
    await (await pending).release()
  })

  test.skipIf(!native)("collector callback failures propagate and release only their own gate", async () => {
    const { registry, id } = await fixture()
    await (await acquire(registry, id)).release()
    await expect(
      Leases.withExclusiveGeneration(registry, id, async () => {
        throw new Error("callback failed")
      }),
    ).rejects.toThrow("callback failed")
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("collected")
  })

  test.skipIf(!native)("two server processes can use one generation; SIGKILL releases the OS lock", async () => {
    const { registry, id } = await fixture()
    const local = await acquire(registry, id)
    const remote = await worker(registry, id)
    expect(remote.ready.proof).toBe("flock")
    const live = await Leases.list(registry, id)
    expect(live.status).toBe("live")
    if (live.status !== "busy") expect(live.leases).toHaveLength(2)
    await local.release()
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
    await stop(remote.child, true)
    expect(await Leases.withExclusiveGeneration(registry, id, async () => "after crash")).toEqual({
      status: "collected",
      value: "after crash",
    })
  })

  test.skipIf(!native)("graceful child release works without deleting its lease file", async () => {
    const { registry, id, root } = await fixture()
    const remote = await worker(registry, id)
    const file = await lockFile(root, id)
    const before = await stat(file)
    await stop(remote.child)
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("collected")
    expect((await stat(file)).ino).toBe(before.ino)
  })

  test.skipIf(!native)("operation namespace is independent and can be acquired before staging exists", async () => {
    const { registry, id } = await fixture()
    const operation = await Leases.acquireOperation(registry, id)
    held.push(operation)
    const generation = await acquire(registry, id)
    await generation.release()
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("collected")
    expect((await Leases.withExclusiveOperation(registry, id, async () => 1)).status).toBe("busy")
    await operation.release()
    expect((await Leases.withExclusiveOperation(registry, id, async () => 1)).status).toBe("collected")
  })

  test.skipIf(!native)("data refs are global across registry overrides and independent from generations", async () => {
    const first = await fixture()
    const second = await fixture()
    const id = `lease.test-${randomUUID()}`
    const data = await Leases.acquireData(first.registry, id)
    held.push(data)
    expect((await Leases.withExclusiveData(second.registry, id, async () => 1)).status).toBe("busy")
    await data.release()
    expect((await Leases.withExclusiveData(second.registry, id, async () => 1)).status).toBe("collected")
  })

  test.skipIf(!native)("first data collection initializes a virgin proof under the common gate", async () => {
    const { registry } = await fixture()
    const id = `lease.virgin-${randomUUID()}`
    const { Global } = await import("@opencode-ai/core/global")
    const directory = path.join(Global.Path.data, "extensions", "data-ref", id)
    expect(await Leases.withExclusiveData(registry, id, async () => "absent data is clean")).toEqual({
      status: "collected",
      value: "absent data is clean",
    })
    expect(JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8")).leases).toEqual([])
    expect(await Leases.withExclusiveData(registry, id, async () => "still virgin")).toEqual({
      status: "collected",
      value: "still virgin",
    })
    const reader = await Leases.acquireData(registry, id)
    held.push(reader)
    expect((await Leases.withExclusiveData(registry, id, async () => 1)).status).toBe("busy")
    await reader.release()
    expect((await Leases.withExclusiveData(registry, id, async () => 1)).status).toBe("collected")
  })

  test.skipIf(!native)(
    "data first-collection does not repair partial, corrupt, unsupported or missing proofs",
    async () => {
      const { registry } = await fixture()
      const { Global } = await import("@opencode-ai/core/global")
      for (const corruption of ["partial", "corrupt", "unsupported", "missing"] as const) {
        const id = `lease.${corruption}-${randomUUID()}`
        const directory = path.join(Global.Path.data, "extensions", "data-ref", id)
        if (corruption === "partial") await mkdir(directory, { recursive: true })
        else {
          const reader = await Leases.acquireData(registry, id)
          held.push(reader)
          await reader.release()
          if (corruption === "corrupt") await writeFile(path.join(directory, "owner.json"), "{}")
          if (corruption === "missing")
            await unlink(await lockFile(path.dirname(path.dirname(directory)), id, "data-ref"))
          if (corruption === "unsupported") {
            const marker = `${randomUUID()}.unsupported`
            await writeFile(path.join(directory, marker), "durable unsupported")
            const ownerPath = path.join(directory, "owner.json")
            const owner = JSON.parse(await readFile(ownerPath, "utf8"))
            const identity = await stat(path.join(directory, marker))
            owner.leases.push({ file: marker, dev: identity.dev, ino: identity.ino })
            await writeFile(ownerPath, JSON.stringify(owner))
          }
        }
        let entered = false
        expect(
          (
            await Leases.withExclusiveData(registry, id, async () => {
              entered = true
            })
          ).status,
        ).toBe("busy")
        expect(entered).toBe(false)
      }
    },
  )

  test.skipIf(!native)("first data collection respects an abandoned common gate", async () => {
    const { registry } = await fixture()
    const { Global } = await import("@opencode-ai/core/global")
    const gate = path.join(Global.Path.data, "extensions", "data-ref", ".gate")
    await mkdir(gate, { recursive: true })
    try {
      await utimes(gate, new Date(0), new Date(0))
      expect((await Leases.withExclusiveData(registry, `lease.gated-${randomUUID()}`, async () => 1)).status).toBe(
        "busy",
      )
      expect((await stat(gate)).isDirectory()).toBe(true)
    } finally {
      await rm(gate, { recursive: true })
    }
  })

  test.skipIf(!native)("canonical registry aliases share references", async () => {
    const { root, registry, id } = await fixture()
    const parent = await fixture()
    const alias = path.join(parent.root, "alias")
    await symlink(root, alias)
    const first = await acquire(registry, id)
    const second = await acquire(path.join(alias, "registry.json"), id)
    await first.release()
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
    await second.release()
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("collected")
  })

  test.skipIf(!native)("corrupt, missing, hardlinked and symlink metadata are never a deletion proof", async () => {
    for (const corruption of ["corrupt", "missing", "symlink", "unknown"] as const) {
      const { registry, id, root } = await fixture()
      await (await acquire(registry, id)).release()
      const file = await lockFile(root, id)
      if (corruption === "corrupt") await writeFile(file, "{}")
      if (corruption === "missing") await unlink(file)
      if (corruption === "symlink") {
        const outside = await fixture()
        const victim = path.join(outside.root, "victim")
        await writeFile(victim, "do not change")
        await unlink(file)
        await symlink(victim, file)
        expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
        expect(await readFile(victim, "utf8")).toBe("do not change")
      }
      if (corruption === "unknown") await writeFile(path.join(root, "ref", id, "unexpected"), "")
      expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
    }
  })

  test.skipIf(!native)("unlink/recreate cannot turn a still-live locked inode into a dead proof", async () => {
    const { registry, id, root } = await fixture()
    await acquire(registry, id)
    const file = await lockFile(root, id)
    const original = await readFile(file)
    // Keep the old inode allocated while replacing its directory entry.
    await rename(file, `${file}.old`)
    await writeFile(file, original)
    await unlink(`${file}.old`)
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
  })

  test.skipIf(!native)("one missing process lease remains busy even with another intact dead proof", async () => {
    const { registry, id, root } = await fixture()
    const local = await acquire(registry, id)
    const localFile = await lockFile(root, id)
    const remote = await worker(registry, id)
    await local.release()
    const all = await readdir(path.join(root, "ref", id))
    const remoteFile = all.find((name) => name.endsWith(".lock") && name !== path.basename(localFile))!
    await unlink(path.join(root, "ref", id, remoteFile))
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
    await stop(remote.child, true)
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
  })

  test.skipIf(!native)("a hard-linked proof or symlink reference directory is untrusted", async () => {
    const { registry, id, root } = await fixture()
    await (await acquire(registry, id)).release()
    const file = await lockFile(root, id)
    const outside = await fixture()
    await link(file, path.join(outside.root, "hard-link"))
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
    const otherId = randomUUID()
    await symlink(path.join(root, "ref", id), path.join(root, "ref", otherId))
    expect((await Leases.withExclusiveGeneration(registry, otherId, async () => 1)).status).toBe("busy")
    await expect(Leases.acquire(registry, otherId)).rejects.toMatchObject({ code: "unsafe" })
  })

  test("an old abandoned mkdir gate is never TTL-reclaimed", async () => {
    const { registry, id, root } = await fixture()
    const gate = path.join(root, "ref", ".gate")
    await mkdir(gate, { recursive: true })
    await utimes(gate, new Date(0), new Date(0))
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
    await expect(Leases.acquire(registry, id)).rejects.toMatchObject({ name: "ExtensionLeaseError", code: "busy" })
    expect((await stat(gate)).isDirectory()).toBe(true)
  })

  test("a held gate reports its namespace so callers can offer an explicit unlock", async () => {
    const { registry, id, root } = await fixture()
    await mkdir(path.join(root, "operation-ref", ".gate"), { recursive: true })
    await expect(Leases.acquireOperation(registry, id)).rejects.toMatchObject({ code: "busy", gate: "operation" })
  })

  test("explicit unlock removes only abandoned gates and restores acquisition", async () => {
    const { registry, id, root } = await fixture()
    const gate = path.join(root, "ref", ".gate")
    await mkdir(gate, { recursive: true })
    await writeFile(path.join(gate, "owner"), randomUUID())
    await utimes(gate, new Date(0), new Date(0))
    const report = await Leases.unlockStaleGates(registry)
    expect(report.removed).toEqual(["generation"])
    expect(await readdir(path.join(root, "ref"))).toEqual([])
    await (await acquire(registry, id)).release()
  })

  test("explicit unlock keeps a recent gate that may still be in use", async () => {
    const { registry, root } = await fixture()
    const gate = path.join(root, "operation-ref", ".gate")
    await mkdir(gate, { recursive: true })
    const report = await Leases.unlockStaleGates(registry)
    expect(report).toMatchObject({ removed: [], recent: ["operation"] })
    expect((await stat(gate)).isDirectory()).toBe(true)
  })

  test("explicit unlock never deletes a gate with unexpected contents", async () => {
    const { registry, root } = await fixture()
    const gate = path.join(root, "ref", ".gate")
    await mkdir(path.join(gate, "nested"), { recursive: true })
    await utimes(gate, new Date(0), new Date(0))
    const report = await Leases.unlockStaleGates(registry)
    expect(report).toMatchObject({ removed: [], untrusted: ["generation"] })
    expect((await stat(path.join(gate, "nested"))).isDirectory()).toBe(true)
  })

  test.skipIf(!native || !node)("a real Node process may run but permanently prevents native collection", async () => {
    const { registry, id, root } = await fixture()
    const remote = await worker(registry, id, node!)
    expect(remote.ready.proof).toBe("unsupported")
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
    await stop(remote.child)
    expect((await readdir(path.join(root, "ref", id))).some((file) => file.endsWith(".unsupported"))).toBe(true)
    expect((await Leases.withExclusiveGeneration(registry, id, async () => 1)).status).toBe("busy")
  })
})
