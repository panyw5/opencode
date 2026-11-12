import { expect, test } from "bun:test"
import { chmod, link, lstat, readFile, rename, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { OwnershipError, tryAcquireOwnership } from "../../src/extension/ownership"
import { fixtureProcess } from "./lifecycle-process"
import { ownershipStorage as storage, ownershipWorker as worker } from "./ownership-fixture"

// Linux and Windows remain blocked until their shared runtime protocol is validated.
const posix = test.skipIf(process.platform !== "darwin")

async function attempt(file: string) {
  try {
    const result = await tryAcquireOwnership(file, "exclusive")
    if (result.status === "acquired") await result.lease.release()
    return result.status
  } catch (error) {
    if (error instanceof OwnershipError) return error.code
    throw error
  }
}

test.skipIf(process.platform === "darwin")("unvalidated platforms fail before touching a guard", async () => {
  await expect(tryAcquireOwnership(path.resolve("unvalidated-platform.lock"), "exclusive")).rejects.toMatchObject({
    code: "unsupported",
  })
})

posix("shared owners exclude an exclusive owner until every descriptor closes", async () => {
  await using f = await storage()
  const first = await tryAcquireOwnership(f.file, "shared")
  expect(first.status).toBe("acquired")
  if (first.status !== "acquired") throw new Error("Missing shared lease")
  await using one = first.lease
  const second = await tryAcquireOwnership(f.file, "shared")
  expect(second.status).toBe("acquired")
  if (second.status !== "acquired") throw new Error("Missing second shared lease")
  await using two = second.lease
  expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
  await one.release()
  expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
  await two.assertHeld()
  await two.release()
  const next = await tryAcquireOwnership(f.file, "exclusive")
  expect(next.status).toBe("acquired")
  if (next.status !== "acquired") throw new Error("Missing exclusive lease")
  await using exclusive = next.lease
  expect(await tryAcquireOwnership(f.file, "shared")).toEqual({ status: "busy" })
  expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
})

posix("release is idempotent and does not unlink or replace the guard", async () => {
  await using f = await storage()
  const result = await tryAcquireOwnership(f.file, "exclusive")
  if (result.status !== "acquired") throw new Error("Missing lease")
  await using lease = result.lease
  const before = await lstat(f.file)
  await lease.assertHeld()
  await lease.release()
  await lease.release()
  await expect(lease.assertHeld()).rejects.toMatchObject({ code: "lost" })
  const after = await lstat(f.file)
  expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
  expect(after.mode & 0o777).toBe(0o600)
})

posix("an assert in flight cannot succeed after the descriptor is released", async () => {
  await using f = await storage()
  const result = await tryAcquireOwnership(f.file, "shared")
  if (result.status !== "acquired") throw new Error("Missing lease")
  await using lease = result.lease
  const asserting = lease.assertHeld().then(
    () => "held",
    (error: unknown) => {
      if (error instanceof OwnershipError) return error.code
      throw error
    },
  )
  const releasing = lease.release()
  expect(await asserting).toBe("lost")
  await releasing
})

posix("an owner must stop when its guard path is replaced", async () => {
  await using f = await storage()
  const result = await tryAcquireOwnership(f.file, "exclusive")
  if (result.status !== "acquired") throw new Error("Missing lease")
  await using lease = result.lease
  await rename(f.file, path.join(f.root, "original.lock"))
  await writeFile(f.file, "replacement", { mode: 0o600 })
  await expect(lease.assertHeld()).rejects.toMatchObject({ code: "lost" })
  await lease.release()
  expect(await readFile(f.file, "utf8")).toBe("replacement")
})

posix("unknown files and symbolic links are rejected without changing their bytes", async () => {
  await using f = await storage()
  await writeFile(f.file, "not an ownership database", { mode: 0o600 })
  expect(await attempt(f.file)).toBe("unsafe")
  expect(await readFile(f.file, "utf8")).toBe("not an ownership database")
  const link = path.join(f.root, "link.lock")
  await symlink(f.file, link)
  expect(await attempt(link)).toBe("unsafe")
  expect(await readFile(f.file, "utf8")).toBe("not an ownership database")
})

posix("guard permissions and hard links cannot bypass private ownership", async () => {
  await using f = await storage()
  const initial = await tryAcquireOwnership(f.file, "exclusive")
  if (initial.status !== "acquired") throw new Error("Missing fixture lease")
  await using lease = initial.lease
  await lease.release()
  const bytes = await readFile(f.file)
  await chmod(f.file, 0o644)
  expect(await attempt(f.file)).toBe("unsafe")
  await chmod(f.file, 0o600)
  await link(f.file, path.join(f.root, "other-name.lock"))
  expect(await attempt(f.file)).toBe("unsafe")
  expect(await readFile(f.file)).toEqual(bytes)
})

posix("a noncanonical directory is rejected before a guard is created", async () => {
  await using f = await storage()
  const alias = path.join(f.root, "alias")
  await symlink(f.root, alias, "dir")
  expect(await attempt(path.join(alias, "ownership.lock"))).toBe("unsafe")
  expect(await Bun.file(f.file).exists()).toBe(false)
})

posix("a shared directory cannot be used as an ownership root", async () => {
  await using f = await storage()
  await chmod(f.root, 0o755)
  expect(await attempt(f.file)).toBe("unsafe")
})

for (const [runtime, executable] of [
  ["bun", process.execPath],
  ["node", Bun.which("node")],
] as const) {
  test.skipIf(!executable || process.platform !== "darwin")(
    `${runtime} crash releases exclusive OS ownership without removing the guard`,
    async () => {
      await using f = await storage()
      await using owner = fixtureProcess(executable!, [worker, f.file, "exclusive"])
      expect((await owner.wait("acquired")).runtime).toBe(runtime)
      const before = await lstat(f.file)
      expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
      expect(await tryAcquireOwnership(f.file, "shared")).toEqual({ status: "busy" })
      owner.signal("SIGKILL")
      expect((await owner.closed()).signal).toBe("SIGKILL")
      const result = await tryAcquireOwnership(f.file, "exclusive")
      expect(result.status).toBe("acquired")
      if (result.status !== "acquired") throw new Error("Dead owner blocked reacquisition")
      await using lease = result.lease
      await lease.assertHeld()
      const after = await lstat(f.file)
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
    },
    30_000,
  )

  test.skipIf(!executable || process.platform !== "darwin")(
    `${runtime} shared owner remains protected when another descriptor opens and closes`,
    async () => {
      await using f = await storage()
      await using reader = fixtureProcess(executable!, [worker, f.file, "shared"])
      expect((await reader.wait("acquired")).runtime).toBe(runtime)
      reader.send({ type: "touch" })
      await reader.wait("touched")
      expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
      const second = await tryAcquireOwnership(f.file, "shared")
      if (second.status !== "acquired") throw new Error("Second shared owner was blocked")
      await using lease = second.lease
      await lease.release()
      expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
      reader.send({ type: "assert" })
      await reader.wait("held")
      reader.send({ type: "exit" })
      expect(await reader.closed()).toEqual({ code: 0, signal: null })
      const result = await tryAcquireOwnership(f.file, "exclusive")
      if (result.status !== "acquired") throw new Error("Released readers blocked exclusive owner")
      await using exclusive = result.lease
      await exclusive.assertHeld()
    },
    30_000,
  )
}
