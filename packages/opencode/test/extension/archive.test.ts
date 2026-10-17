import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { gzipSync, gunzipSync } from "node:zlib"
import tar from "tar-stream"
import { archiveLimits, extractArchive } from "../../src/extension/archive"

const root = await mkdtemp(path.join(await realpath(tmpdir()), "oc-extension-archive-"))
afterAll(() => rm(root, { recursive: true, force: true }))
let serial = 0
const destination = () => path.join(root, `extract-${serial++}`)

type Entry = Partial<tar.Headers> & { name: string; body?: string | Buffer; pax?: Record<string, string> }
async function archive(entries: Entry[]) {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const collected = (async () => {
    for await (const chunk of pack) chunks.push(chunk)
  })()
  for (const { body = "", ...header } of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry(header, body, (error) => (error ? reject(error) : resolve()))
    })
  }
  pack.finalize()
  await collected
  return gzipSync(Buffer.concat(chunks))
}

async function rejected(input: Uint8Array, options: Partial<Parameters<typeof extractArchive>[0]> = {}) {
  const directory = destination()
  await expect(extractArchive({ input, directory, ...options })).rejects.toThrow()
  expect(await lstat(directory).catch(() => undefined)).toBeUndefined()
}

function mutate(input: Uint8Array, apply: (tar: Buffer) => Buffer | void) {
  const raw = gunzipSync(input)
  const changed = apply(raw) ?? raw
  return gzipSync(changed)
}

function checksum(header: Buffer) {
  header.fill(32, 148, 156)
  const sum = header.reduce((total, value) => total + value, 0)
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
}

describe("extension archive", () => {
  test("extracts buffers with fixed package root, private modes and no script execution", async () => {
    const directory = destination()
    const marker = path.join(root, "script-was-run")
    const json = JSON.stringify({ scripts: { postinstall: `touch ${marker}` } })
    const input = await archive([
      { name: "package/package.json", body: json, mode: 0o7777, uid: 12345, gid: 12345 },
      { name: "package/dist/index.js", body: "export default 1", mode: 0o7777 },
      // A parent may be implicit before it is explicitly declared.
      { name: "package/dist/", type: "directory" },
      { name: "package/", type: "directory" },
    ])
    expect(await extractArchive({ input, directory })).toEqual({ bytes: Buffer.byteLength(json) + 16, files: 2 })
    expect(await readFile(path.join(directory, "dist/index.js"), "utf8")).toBe("export default 1")
    expect(await lstat(marker).catch(() => undefined)).toBeUndefined()
    expect((await lstat(directory)).mode & 0o777).toBe(0o700)
    expect((await lstat(path.join(directory, "dist"))).mode & 0o777).toBe(0o700)
    expect((await lstat(path.join(directory, "package.json"))).mode & 0o7777).toBe(0o600)
  })

  test("accepts chunked Readable input, PAX long UTF-8 names, and npm policy", async () => {
    const directory = destination()
    const name = `package/${"文件".repeat(20)}.js`
    const input = await archive([{ name, body: "safe" }])
    const chunks = Array.from({ length: Math.ceil(input.length / 7) }, (_, index) =>
      input.subarray(index * 7, index * 7 + 7),
    )
    expect(await extractArchive({ input: Readable.from(chunks), directory, policy: "npm" })).toEqual({
      bytes: 4,
      files: 1,
    })
    expect(await readFile(path.join(directory, name.slice(8)), "utf8")).toBe("safe")
  })

  test.each([
    "../escaped",
    "package/../escaped",
    "/package/absolute",
    "//server/share",
    "C:/package/drive",
    "package/C:ads",
    "package/a\\b",
    "package/a?b",
    'package/a"b',
    "package/a*b",
    "package/a<b",
    "package/a|b",
    "package/./dot",
    "package//empty",
    "package/a/../../escape",
    "package/CON",
    "package/nul.txt",
    "package/COM1.js",
    "package/lpt¹.txt",
    "package/trailing.",
    "package/trailing ",
    "package/a\nname",
    "other/root",
  ])("rejects unsafe path %s and removes partial output", async (name) => {
    await rejected(
      await archive([
        { name: "package/ok", body: "ok" },
        { name, body: "bad" },
      ]),
    )
  })

  test.each([
    "node_modules",
    ".npmrc",
    ".git",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
  ])("rejects forbidden component %s at every depth under both policies", async (name) => {
    for (const policy of ["archive", "npm"] as const) {
      for (const prefix of ["package/", "package/deep/"]) {
        await rejected(await archive([{ name: `${prefix}${name.toUpperCase()}/file`, body: "bad" }]), { policy })
      }
    }
  })

  test.each(["symlink", "link", "fifo", "character-device", "block-device", "contiguous-file"] as const)(
    "rejects %s entries",
    async (type) => {
      await rejected(await archive([{ name: "package/escape", type, linkname: "../../marker" }]))
    },
  )

  test("rejects raw GNU sparse and unknown entry types", async () => {
    const input = await archive([{ name: "package/file", body: "x" }])
    for (const type of ["S", "Z"]) {
      await rejected(
        mutate(input, (raw) => {
          raw[156] = type.charCodeAt(0)
          checksum(raw.subarray(0, 512))
        }),
      )
    }
  })

  test("validates the effective PAX overridden name", async () => {
    await rejected(await archive([{ name: "package/safe", body: "bad", pax: { path: "package/../../escape" } }]))
    await rejected(await archive([{ name: "package/safe", body: "bad", pax: { path: "package/node_modules/evil" } }]))
    await rejected(await archive([{ name: "package/safe", body: "bad", pax: { "GNU.sparse.map": "0,1" } }]))
    await rejected(await archive([{ name: "package/safe", body: "bad", pax: { "SCHILY.filetype": "sparse" } }]))
    const directory = destination()
    await extractArchive({
      input: await archive([{ name: "package/old", body: "ok", pax: { path: "package/new" } }]),
      directory,
    })
    expect(await readFile(path.join(directory, "new"), "utf8")).toBe("ok")
    expect(await lstat(path.join(directory, "old")).catch(() => undefined)).toBeUndefined()
  })

  test.each([
    ["package/file", "package/file"],
    ["package/File", "package/file"],
    ["package/A/file", "package/a/other"],
    ["package/file", "package/file/child"],
    ["package/é", "package/e\u0301"],
  ])("rejects duplicate or colliding paths %s and %s", async (first, second) => {
    await rejected(
      await archive([
        { name: first, body: "first" },
        { name: second, body: "second" },
      ]),
    )
  })

  test("rejects duplicate explicit directories and replacing directories with files", async () => {
    await rejected(
      await archive([
        { name: "package/a/", type: "directory" },
        { name: "package/a/", type: "directory" },
      ]),
    )
    await rejected(
      await archive([
        { name: "package/a/", type: "directory" },
        { name: "package/a", body: "bad" },
      ]),
    )
  })

  test("preserves preexisting destinations including symlinks and files", async () => {
    const input = await archive([{ name: "package/marker", body: "overwrite" }])
    const directory = destination()
    await mkdir(directory)
    await writeFile(path.join(directory, "marker"), "original")
    await expect(extractArchive({ input, directory })).rejects.toThrow()
    expect(await readFile(path.join(directory, "marker"), "utf8")).toBe("original")
    const link = destination()
    await symlink(directory, link)
    await expect(extractArchive({ input, directory: link })).rejects.toThrow()
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    const file = destination()
    await writeFile(file, "original")
    await expect(extractArchive({ input, directory: file })).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe("original")
  })

  test("rejects symbolic-link ancestors without deleting their target", async () => {
    const parent = destination()
    const link = destination()
    await mkdir(parent)
    await writeFile(path.join(parent, "marker"), "keep")
    await symlink(parent, link)
    await expect(
      extractArchive({
        input: await archive([{ name: "package/a", body: "bad" }]),
        directory: path.join(link, "output"),
      }),
    ).rejects.toThrow()
    expect(await readFile(path.join(parent, "marker"), "utf8")).toBe("keep")
    expect(await lstat(path.join(parent, "output")).catch(() => undefined)).toBeUndefined()
  })

  test("rejects truncated gzip, truncated tar, corrupt gzip and corrupt headers", async () => {
    const input = await archive([{ name: "package/file", body: "content" }])
    await rejected(input.subarray(0, input.length - 5))
    await rejected(mutate(input, (raw) => raw.subarray(0, 700)))
    await rejected(mutate(input, (raw) => raw.subarray(0, raw.length - 512)))
    await rejected(
      mutate(input, (raw) => {
        raw[0] ^= 1
      }),
    )
    const corrupt = Buffer.from(input)
    corrupt[corrupt.length - 6] ^= 1
    await rejected(corrupt)
    await rejected(Buffer.from("not a gzip"))
  })

  test("enforces injected compressed, inflated, file, entry, path, depth and metadata limits", async () => {
    const input = await archive([{ name: "package/dir/file", body: "contents" }])
    await rejected(input, { limits: { compressedBytes: input.length - 1 } })
    await rejected(input, { limits: { inflatedBytes: gunzipSync(input).length - 1 } })
    await rejected(input, { limits: { fileBytes: 7 } })
    await rejected(input, { limits: { entries: 0 } })
    await rejected(input, { limits: { depth: 1 } })
    await rejected(input, { limits: { pathBytes: 10 } })
    const metadata = await archive([{ name: "package/file", body: "x", pax: { comment: "a".repeat(128) } }])
    await rejected(metadata, { limits: { metadataBytes: 32 } })
    const two = await archive([
      { name: "package/a", body: "x" },
      { name: "package/b", body: "x" },
    ])
    await rejected(two, { limits: { entries: 1 } })
    const directory = destination()
    expect(
      await extractArchive({
        input,
        directory,
        limits: {
          compressedBytes: input.length,
          inflatedBytes: gunzipSync(input).length,
          fileBytes: 8,
          depth: 2,
          entries: 1,
          pathBytes: 16,
        },
      }),
    ).toEqual({ bytes: 8, files: 1 })
    expect(archiveLimits.fileBytes).toBe(128 * 1024 * 1024)
  })

  test("enforces aggregate metadata and counts metadata entries", async () => {
    const input = await archive([
      { name: "package/a", body: "x", pax: { comment: "a".repeat(32) } },
      { name: "package/b", body: "x", pax: { comment: "b".repeat(32) } },
    ])
    await rejected(input, { limits: { metadataBytes: 100 } })
    await rejected(input, { limits: { entries: 3 } })
  })

  test("aborts before creation and while a source is stalled, and destroys the source", async () => {
    const controller = new AbortController()
    controller.abort()
    await rejected(await archive([{ name: "package/a", body: "ok" }]), { signal: controller.signal })
    const directory = destination()
    const source = new Readable({ read() {} })
    const running = new AbortController()
    const extracting = extractArchive({ input: source, directory, signal: running.signal })
    const failed = extracting.then(
      () => undefined,
      (error: unknown) => error,
    )
    for (let attempt = 0; attempt < 100 && !source.listenerCount("data"); attempt++) await Bun.sleep(1)
    running.abort()
    expect(await failed).toBeInstanceOf(Error)
    expect(source.destroyed).toBe(true)
    expect(await lstat(directory).catch(() => undefined)).toBeUndefined()
  })

  test("extracts GNU long paths but rejects unsafe and global metadata", async () => {
    const name = `package/${"long".repeat(30)}`
    const encoded = await archive([{ name, body: "ok" }])
    const raw = gunzipSync(encoded)
    const rawSize = Number.parseInt(raw.toString("ascii", 124, 136).replace(/\0.*$/, "").trim(), 8)
    const metadataBlocks = 512 + Math.ceil(rawSize / 512) * 512
    const longHeader = Buffer.from(raw.subarray(0, 512))
    const longBody = Buffer.from(`${name}\0`)
    longHeader[156] = "L".charCodeAt(0)
    longHeader.write(`${longBody.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii")
    checksum(longHeader)
    const input = gzipSync(
      Buffer.concat([
        longHeader,
        longBody,
        Buffer.alloc((512 - (longBody.length % 512)) % 512),
        raw.subarray(metadataBlocks),
      ]),
    )
    const directory = destination()
    await extractArchive({ input, directory })
    expect(await readFile(path.join(directory, name.slice(8)), "utf8")).toBe("ok")
    await rejected(
      mutate(input, (data) => {
        const bad = "package/../escaped"
        data.fill(0, 512, 1024)
        data.write(bad, 512)
      }),
    )
    await rejected(
      mutate(encoded, (data) => {
        data[156] = "g".charCodeAt(0)
        checksum(data.subarray(0, 512))
      }),
    )
  })

  test("rejects malformed PAX and oversized PAX effective sizes", async () => {
    const input = await archive([{ name: "package/a", body: "x", pax: { comment: "safe" } }])
    await rejected(
      mutate(input, (data) => {
        data[512] = 48
      }),
    )
    await rejected(await archive([{ name: "package/a", body: "x", pax: { size: "9999999999999999" } }]))
    await rejected(await archive([{ name: "package/a", body: "x", pax: { size: "129" } }]), {
      limits: { fileBytes: 128 },
    })
    await rejected(mutate(input, (data) => data.subarray(0, 1024)))
  })

  test("supports empty archives and zero-byte files without phantom files", async () => {
    const directory = destination()
    expect(await extractArchive({ input: await archive([]), directory })).toEqual({ bytes: 0, files: 0 })
    const empty = destination()
    expect(await extractArchive({ input: await archive([{ name: "package/empty" }]), directory: empty })).toEqual({
      bytes: 0,
      files: 1,
    })
  })

  test("validates injected limits and rejects data appended after tar terminators", async () => {
    const input = await archive([{ name: "package/a", body: "x" }])
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      await rejected(input, { limits: { entries: value } })
    }
    await rejected(mutate(input, (data) => Buffer.concat([data, data])))
  })

  test("cleans newly created output after source errors but preserves siblings", async () => {
    const marker = path.join(root, "outside-marker")
    await writeFile(marker, "keep")
    const directory = destination()
    const source = new Readable({
      read() {
        this.destroy(new Error("download failed"))
      },
    })
    await expect(extractArchive({ input: source, directory })).rejects.toThrow("download failed")
    expect(await lstat(directory).catch(() => undefined)).toBeUndefined()
    expect(await readFile(marker, "utf8")).toBe("keep")
  })
})
