import { describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { extensionPackage } from "./fixture"
import { Process } from "../../src/util/process"

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/extension-registry-worker.ts")

describe("extension registry concurrency", () => {
  test("serializes concurrent links across processes", async () => {
    await using tmp = await tmpdir()
    const registry = path.join(tmp.path, "registry.json")
    const packages = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        extensionPackage(tmp.path, { id: `test.extension-${index}`, name: `extension-${index}` }),
      ),
    )

    const out = await Promise.all(
      packages.map((directory) =>
        Process.run([process.execPath, worker, registry, directory], {
          cwd: root,
          nothrow: true,
        }),
      ),
    )
    expect(out.map((item) => ({ code: item.code, stderr: item.stderr.toString() }))).toEqual(
      packages.map(() => ({ code: 0, stderr: "" })),
    )
    const store = await Bun.file(registry).json()
    expect(Object.keys(store.extensions).sort()).toEqual(packages.map((_, index) => `test.extension-${index}`))
  }, 25_000)
})
