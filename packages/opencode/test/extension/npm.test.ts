import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { materializeNpm, resolveNpm, validateNpmRoot, type NpmExtract } from "../../src/extension/npm"
import { extractArchive } from "../../src/extension/archive"
import { downloadPackage, requestJson, type DownloadTransport } from "../../src/extension/download"

const registry = "https://registry.example.test/"
type Package = {
  name: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional: boolean }>
  scripts?: Record<string, string>
  [key: string]: unknown
}
async function fixtures(packages: Package[]) {
  const metadata: Record<string, any> = {}
  const archives = new Map<string, Uint8Array>()
  const manifests = new Map<string, Record<string, unknown>>()
  for (const input of packages) {
    const pkg = { version: "1.0.0", main: "index.cjs", ...input }
    const source = `module.exports = {name:${JSON.stringify(pkg.name)},version:${JSON.stringify(pkg.version)},load:(name)=>require(name)}`
    const bytes = await new Bun.Archive(
      {
        "package/package.json": JSON.stringify(pkg),
        "package/index.cjs": source,
      },
      { compress: "gzip" },
    ).bytes()
    const tarball = `${registry}${encodeURIComponent(pkg.name)}/-/${pkg.version}.tgz`
    const manifest = {
      ...pkg,
      dist: { tarball, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` },
    }
    const document = (metadata[pkg.name] ??= { name: pkg.name, "dist-tags": {}, versions: {} })
    document.versions[pkg.version] = manifest
    document["dist-tags"].latest = pkg.version
    archives.set(tarball, bytes)
    manifests.set(`${pkg.name}@${pkg.version}`, manifest)
  }
  const requests: string[] = []
  const downloads: string[] = []
  return {
    metadata,
    archives,
    manifests,
    requests,
    downloads,
    options: {
      registry,
      transport: async (url: string) => {
        requests.push(url)
        const name = decodeURIComponent(new URL(url).pathname.slice(1))
        if (!Object.hasOwn(metadata, name)) throw new Error(`missing local metadata: ${name}`)
        return structuredClone(metadata[name])
      },
    },
    download: async ({ url }: { url: string }) => {
      downloads.push(url)
      const bytes = archives.get(url)
      if (!bytes) throw new Error("missing local tarball")
      return bytes
    },
  }
}
// Test-only fixture extractor. Production must inject the hardened archive module, never this adapter.
const extract: NpmExtract = async (input, options) => {
  await mkdir(options.directory, { mode: 0o700 })
  for (const [name, entry] of await new Bun.Archive(input).files()) {
    const target = path.join(options.directory, name.slice("package/".length))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, new Uint8Array(await entry.arrayBuffer()))
  }
}
async function temporary() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "oc-strict-npm-")))
  return { directory, [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }) }
}

describe("strict extension npm adapter", () => {
  test("selects exact semver/tag versions, scoped names and immutable graph-bound lock", async () => {
    const f = await fixtures([
      { name: "@scope/ext", version: "1.0.0" },
      { name: "@scope/ext", version: "1.2.0" },
    ])
    const prepared = await resolveNpm("@scope/ext@^1", f.options)
    expect(prepared.version).toBe("1.2.0")
    expect(prepared.name).toBe("@scope/ext")
    expect(prepared.registry).toBe(registry)
    expect(prepared.lockDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(prepared.graph[0].declarations.dependencies)).toBe(true)
    expect((await resolveNpm("@scope/ext@latest", f.options)).version).toBe("1.2.0")
    expect(f.downloads).toEqual([])
  })

  test.each([
    "git+https://example.test/ext.git",
    "github:owner/ext",
    "file:./ext",
    "./ext",
    "workspace:*",
    "link:./ext",
    "https://example.test/ext.tgz",
    "ext@npm:other@1",
    "ext@http://example.test/x.tgz",
  ])("rejects a direct non-registry spec before transport: %s", async (spec) => {
    let calls = 0
    await expect(
      resolveNpm(spec, {
        transport: async () => {
          calls++
          return {}
        },
      }),
    ).rejects.toThrow("Strict npm")
    expect(calls).toBe(0)
  })

  test.each(["dependencies", "optionalDependencies", "peerDependencies"])(
    "rejects dangerous %s edges before querying them",
    async (kind) => {
      for (const spec of [
        "git+https://evil.test/x.git",
        "file:../escape",
        "workspace:*",
        "link:../x",
        "https://evil.test/x.tgz",
        "npm:other@1",
      ]) {
        const f = await fixtures([{ name: "ext", [kind]: { unsafe: spec } }])
        await expect(resolveNpm("ext", f.options)).rejects.toThrow("Strict npm")
        expect(f.requests).toEqual([`${registry}ext`])
        expect(f.downloads).toEqual([])
      }
    },
  )

  test("checks deep and optional dependency graphs before downloading anything", async () => {
    const f = await fixtures([
      { name: "ext", dependencies: { middle: "^1" } },
      { name: "middle", optionalDependencies: { leaf: "1.0.0" } },
      { name: "leaf", dependencies: { unsafe: "file:/etc" } },
    ])
    await expect(resolveNpm("ext", f.options)).rejects.toThrow("registry-only")
    expect(f.requests).toHaveLength(3)
    expect(f.downloads).toEqual([])
    delete f.manifests.get("leaf@1.0.0")!.dependencies
    const prepared = await resolveNpm("ext", f.options)
    expect(prepared.graph).toHaveLength(3)
    expect(prepared.graph[2].directory).toBe("package/node_modules/middle/node_modules/leaf")
  })

  test("does not silently discard missing required optional packages", async () => {
    const f = await fixtures([{ name: "ext", optionalDependencies: { missing: "1.0.0" } }])
    await expect(resolveNpm("ext", f.options)).rejects.toThrow("missing local metadata")
    expect(f.downloads).toEqual([])
  })

  test("requires compatible peers; explicitly optional absent peers are allowed", async () => {
    const missing = await fixtures([{ name: "ext", peerDependencies: { peer: "^1" } }])
    await expect(resolveNpm("ext", missing.options)).rejects.toThrow("unsatisfied peer")
    const optional = await fixtures([
      { name: "ext", peerDependencies: { peer: "^1" }, peerDependenciesMeta: { peer: { optional: true } } },
    ])
    expect((await resolveNpm("ext", optional.options)).graph).toHaveLength(1)
    const conflict = await fixtures([
      { name: "ext", dependencies: { child: "1", peer: "2" } },
      { name: "child", peerDependencies: { peer: "^1" } },
      { name: "peer", version: "2.0.0" },
    ])
    await expect(resolveNpm("ext", conflict.options)).rejects.toThrow("unsatisfied peer")
  })

  test("rejects cross-origin tarballs, weak/missing integrity, native and bundled metadata", async () => {
    for (const change of [
      (p: any) => {
        p.dist.tarball = "https://evil.test/evil.tgz"
      },
      (p: any) => {
        p.dist.integrity = "sha1-AAAA"
      },
      (p: any) => {
        p.dist.integrity = `sha512-invalid sha256-${Buffer.alloc(32).toString("base64")}`
      },
      (p: any) => {
        delete p.dist.integrity
      },
      (p: any) => {
        p.gypfile = true
      },
      (p: any) => {
        p.scripts = { install: "node-gyp rebuild" }
      },
      (p: any) => {
        p.bundledDependencies = ["hidden"]
      },
    ]) {
      const f = await fixtures([{ name: "ext" }])
      change(f.manifests.get("ext@1.0.0"))
      await expect(resolveNpm("ext", f.options)).rejects.toThrow("Strict npm")
      expect(f.downloads).toEqual([])
    }
  })

  test("rejects cycles and bounded deep graphs instead of pretending resolution succeeded", async () => {
    const cyclic = await fixtures([
      { name: "ext", dependencies: { child: "1" } },
      { name: "child", dependencies: { ext: "1" } },
    ])
    await expect(resolveNpm("ext", cyclic.options)).rejects.toThrow("cyclic")
    const deep = await fixtures(
      Array.from({ length: 23 }, (_, i) => ({
        name: `dep${i}`,
        ...(i < 22 && { dependencies: { [`dep${i + 1}`]: "1" } }),
      })),
    )
    await expect(resolveNpm("dep0", deep.options)).rejects.toThrow("graph limit")
  })

  test("materializes actual tgz packages with nested conflicting versions and sibling peers without scripts or bins", async () => {
    await using temp = await temporary()
    const f = await fixtures([
      {
        name: "ext",
        dependencies: { a: "1", b: "1", peer: "1" },
        scripts: { install: "touch SCRIPT_EXECUTED" },
        bin: { dangerous: "index.cjs" },
      },
      { name: "a", dependencies: { leaf: "^1" }, peerDependencies: { peer: "1" } },
      { name: "b", dependencies: { leaf: "^2" } },
      { name: "leaf", version: "1.0.0" },
      { name: "leaf", version: "2.0.0" },
      { name: "peer" },
    ])
    const prepared = await resolveNpm("ext", f.options)
    const result = await materializeNpm(prepared, {
      directory: path.join(temp.directory, "generation"),
      download: f.download,
      extract,
    })
    const require = createRequire(path.join(result.directory, "package.json"))
    const extension = require(result.directory)
    expect(extension.load("a").load("leaf").version).toBe("1.0.0")
    expect(extension.load("b").load("leaf").version).toBe("2.0.0")
    expect(extension.load("a").load("peer").version).toBe("1.0.0")
    expect(f.downloads).toHaveLength(6)
    expect(await Bun.file(path.join(result.directory, "SCRIPT_EXECUTED")).exists()).toBe(false)
    expect(await Bun.file(path.join(result.directory, "node_modules/.bin/dangerous")).exists()).toBe(false)
    const lock = JSON.parse(await readFile(path.join(temp.directory, "generation/npm-lock.json"), "utf8"))
    expect(lock.lockDigest).toBe(prepared.lockDigest)
    expect(await Bun.file(path.join(result.directory, "npm-lock.json")).exists()).toBe(false)
  })

  test("materializes scoped dependencies and binds the graph digest to transitive integrity", async () => {
    await using temp = await temporary()
    const f = await fixtures([{ name: "@scope/ext", dependencies: { "@scope/child": "^1" } }, { name: "@scope/child" }])
    const prepared = await resolveNpm("@scope/ext", f.options)
    const result = await materializeNpm(prepared, {
      directory: path.join(temp.directory, "generation"),
      download: f.download,
      extract,
    })
    const require = createRequire(path.join(result.directory, "package.json"))
    expect(require(result.directory).load("@scope/child").name).toBe("@scope/child")
    f.manifests.get("@scope/child@1.0.0")!.dist = {
      tarball: `${registry}%40scope%2Fchild/-/1.0.0.tgz`,
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    }
    const changed = await resolveNpm("@scope/ext", f.options)
    expect(changed.lockDigest).not.toBe(prepared.lockDigest)
    expect(changed.integrity).toBe(prepared.integrity)
  })

  test("validates a root preview against the authorized metadata graph", async () => {
    await using temp = await temporary()
    const f = await fixtures([{ name: "ext" }])
    const prepared = await resolveNpm("ext", f.options)
    const directory = path.join(temp.directory, "package")
    await extract(f.archives.get(prepared.tarball)!, { directory })
    await validateNpmRoot(prepared, directory)
    await expect(validateNpmRoot({ ...prepared }, directory)).rejects.toThrow("unrecognized prepared graph")
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "ext", version: "1.0.0", dependencies: { hidden: "1" } }),
    )
    await expect(validateNpmRoot(prepared, directory)).rejects.toThrow("does not match")
  })

  test("composes safe metadata/download/archive adapters offline for preview and nested materialization", async () => {
    await using temp = await temporary()
    const f = await fixtures([
      { name: "ext", dependencies: { "@scope/child": "1" }, scripts: { postinstall: "touch DO_NOT_EXECUTE" } },
      { name: "@scope/child", dependencies: { leaf: "2" } },
      { name: "leaf", version: "2.0.0" },
    ])
    const requests: string[] = []
    const transport: DownloadTransport = {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      request: async ({ url, address }) => {
        expect(address).toBe("8.8.8.8")
        requests.push(url.href)
        const archive = f.archives.get(url.href)
        const body =
          archive ?? new TextEncoder().encode(JSON.stringify(f.metadata[decodeURIComponent(url.pathname.slice(1))]))
        return {
          status: 200,
          headers: {},
          body: (async function* () {
            yield body
          })(),
        }
      },
    }
    const prepared = await resolveNpm("ext", {
      registry,
      transport: (url, options) => requestJson(url, { ...options, transport }),
    })
    const download = (input: Parameters<typeof downloadPackage>[0]) => downloadPackage({ ...input, transport })
    const safeExtract: NpmExtract = (input, options) => extractArchive({ input, ...options, policy: "npm" })
    expect(requests.every((url) => !url.endsWith(".tgz"))).toBe(true)
    const preview = path.join(temp.directory, "preview")
    await safeExtract(await download({ url: prepared.tarball, integrity: prepared.integrity }), { directory: preview })
    await validateNpmRoot(prepared, preview)
    const result = await materializeNpm(prepared, {
      directory: path.join(temp.directory, "generation"),
      download,
      extract: safeExtract,
    })
    const require = createRequire(path.join(result.directory, "package.json"))
    expect(require(result.directory).load("@scope/child").load("leaf").version).toBe("2.0.0")
    expect(await Bun.file(path.join(result.directory, "DO_NOT_EXECUTE")).exists()).toBe(false)
    expect(requests.filter((url) => url.endsWith(".tgz"))).toHaveLength(4)
  })

  test("rejects forged prepared graphs and tampered tgz before extraction", async () => {
    await using temp = await temporary()
    const f = await fixtures([{ name: "ext" }])
    const prepared = await resolveNpm("ext", f.options)
    const directory = path.join(temp.directory, "generation")
    await expect(materializeNpm({ ...prepared }, { directory, download: f.download, extract })).rejects.toThrow(
      "unrecognized prepared graph",
    )
    let calls = 0
    await expect(
      materializeNpm(prepared, {
        directory,
        download: async () => new Uint8Array([0]),
        extract: async () => {
          calls++
        },
      }),
    ).rejects.toThrow("integrity mismatch")
    expect(calls).toBe(0)
  })

  test("rejects mismatched extracted declarations and native payloads", async () => {
    await using temp = await temporary()
    const f = await fixtures([{ name: "ext" }])
    const prepared = await resolveNpm("ext", f.options)
    for (const [i, mutate] of [
      async (directory: string) =>
        writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({ name: "ext", version: "1.0.0", dependencies: { hidden: "file:../evil" } }),
        ),
      async (directory: string) => writeFile(path.join(directory, "binding.gyp"), "{}"),
      async (directory: string) => mkdir(path.join(directory, "node_modules")),
    ].entries()) {
      await expect(
        materializeNpm(prepared, {
          directory: path.join(temp.directory, `generation${i}`),
          download: f.download,
          extract: async (bytes, options) => {
            await extract(bytes, options)
            await mutate(options.directory)
          },
        }),
      ).rejects.toThrow("Strict npm")
    }
  })

  test("honors abort before metadata and before materialization", async () => {
    const controller = new AbortController()
    controller.abort()
    const f = await fixtures([{ name: "ext" }])
    await expect(resolveNpm("ext", { ...f.options, signal: controller.signal })).rejects.toThrow()
    expect(f.requests).toEqual([])
    const prepared = await resolveNpm("ext", f.options)
    await using temp = await temporary()
    await expect(
      materializeNpm(prepared, {
        directory: path.join(temp.directory, "generation"),
        signal: controller.signal,
        download: f.download,
        extract,
      }),
    ).rejects.toThrow()
    expect(f.downloads).toEqual([])
  })
})
