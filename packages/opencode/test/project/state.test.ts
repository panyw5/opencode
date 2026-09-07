import { afterEach, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"

import { Path } from "@opencode-ai/core/util/path"
import { Instance } from "../../src/project/instance"
import { localPathContext } from "../../src/project/instance-context"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

test("Instance.state caches values for the same instance", async () => {
  await using tmp = await tmpdir()
  let n = 0
  const state = Instance.state(() => ({ n: ++n }))

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const a = state()
      const b = state()
      expect(a).toBe(b)
      expect(n).toBe(1)
    },
  })
})

test("Instance.state isolates values by directory", async () => {
  await using a = await tmpdir()
  await using b = await tmpdir()
  let n = 0
  const state = Instance.state(() => ({ n: ++n }))

  const x = await Instance.provide({
    directory: a.path,
    fn: async () => state(),
  })
  const y = await Instance.provide({
    directory: b.path,
    fn: async () => state(),
  })
  const z = await Instance.provide({
    directory: a.path,
    fn: async () => state(),
  })

  expect(x).toBe(z)
  expect(x).not.toBe(y)
  expect(n).toBe(2)
})

test("Instance.state is disposed on instance reload", async () => {
  await using tmp = await tmpdir()
  const seen: string[] = []
  let n = 0
  const state = Instance.state(
    () => ({ n: ++n }),
    async (value) => {
      seen.push(String(value.n))
    },
  )

  const a = await Instance.provide({
    directory: tmp.path,
    fn: async () => state(),
  })
  await Instance.reload({ directory: tmp.path })
  const b = await Instance.provide({
    directory: tmp.path,
    fn: async () => state(),
  })

  expect(a).not.toBe(b)
  expect(seen).toEqual(["1"])
})

test("Instance.state is disposed on disposeAll", async () => {
  await using a = await tmpdir()
  await using b = await tmpdir()
  const seen: string[] = []
  const state = Instance.state(
    () => ({ dir: Instance.directory }),
    async (value) => {
      seen.push(value.dir)
    },
  )

  await Instance.provide({
    directory: a.path,
    fn: async () => state(),
  })
  await Instance.provide({
    directory: b.path,
    fn: async () => state(),
  })
  await Instance.disposeAll()

  expect(seen.sort()).toEqual([a.path, b.path].map((path) => Path.logical(path, localPathContext)).sort())
})

test("Instance.state dedupes concurrent promise initialization", async () => {
  await using tmp = await tmpdir()
  let n = 0
  const state = Instance.state(async () => {
    n += 1
    await Bun.sleep(10)
    return { n }
  })

  const [a, b] = await Instance.provide({
    directory: tmp.path,
    fn: async () => Promise.all([state(), state()]),
  })

  expect(a).toBe(b)
  expect(n).toBe(1)
})

test("Instance shares one cache and state across Windows path aliases", async () => {
  if (process.platform !== "win32") return
  await using tmp = await tmpdir()
  const match = tmp.path.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!match) return
  const alias = `${match[1]!.toLowerCase()}:/${match[2]!.replaceAll("\\", "/")}`
  let initialized = 0
  const state = Instance.state(() => ({ initialized: ++initialized }))

  const [first, second] = await Promise.all([
    Instance.provide({ directory: tmp.path, init: async () => undefined, fn: () => ({ ctx: Instance.current, state: state() }) }),
    Instance.provide({ directory: alias, fn: () => ({ ctx: Instance.current, state: state() }) }),
  ])

  expect(first.ctx).toBe(second.ctx)
  expect(first.ctx.directoryKey).toBe(second.ctx.directoryKey)
  expect(first.state).toBe(second.state)
  expect(initialized).toBe(1)
})

test("Instance resolves Windows compatibility drive prefixes before identity", async () => {
  if (process.platform !== "win32") return
  await using tmp = await tmpdir()
  const match = tmp.path.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!match) return
  const drive = match[1]!.toLowerCase()
  const rest = match[2]!.replaceAll("\\", "/")
  const aliases = [`/${drive}/${rest}`, `/mnt/${drive}/${rest}`, `/cygdrive/${drive}/${rest}`]
  const contexts = await Promise.all(
    aliases.map((directory) => Instance.provide({ directory, fn: () => Instance.current })),
  )

  expect(new Set(contexts.map((ctx) => ctx.directoryKey)).size).toBe(1)
})

test("Instance keeps POSIX path identity case-sensitive", async () => {
  if (process.platform === "win32") return
  await using tmp = await tmpdir({
    init: async (dir) => {
      await mkdir(`${dir}/lower`)
      await mkdir(`${dir}/UPPER`)
      await Bun.write(`${dir}/lower/.keep`, "")
      await Bun.write(`${dir}/UPPER/.keep`, "")
    },
  })
  const lower = `${tmp.path}/lower`
  const upper = `${tmp.path}/UPPER`

  const [a, b] = await Promise.all([
    Instance.provide({ directory: lower, fn: () => Instance.current }),
    Instance.provide({ directory: upper, fn: () => Instance.current }),
  ])

  expect(a.directoryKey).not.toBe(b.directoryKey)
  expect(a.directory).not.toBe(b.directory)
})
