import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import {
  ArchiveDownloadError,
  copyLocalArchive,
  downloadArchive,
  downloadPackage,
  readLocalArchive,
  requestJson,
  type DownloadAddress,
  type DownloadResponse,
  type DownloadTransport,
} from "../../src/extension/download"

const bytes = Buffer.from("extension archive payload")
const hash = (value: Uint8Array = bytes) => createHash("sha256").update(value).digest("hex")
const integrity = (value: Uint8Array = bytes) => `sha512-${createHash("sha512").update(value).digest("base64")}`
const url = "https://packages.example.test/archive.tgz?token=private-token"
const publicIP: DownloadAddress = { address: "93.184.216.34", family: 4 }

function response(options: Partial<DownloadResponse> = {}): DownloadResponse {
  return {
    status: 200,
    headers: {},
    body: (async function* () {
      yield bytes
    })(),
    ...options,
  }
}

function fixture(
  options: {
    lookup?: DownloadTransport["lookup"]
    request?: DownloadTransport["request"]
  } = {},
) {
  const requests: Parameters<DownloadTransport["request"]>[0][] = []
  const lookups: string[] = []
  const transport: DownloadTransport = {
    async lookup(host, signal) {
      lookups.push(host)
      return options.lookup ? options.lookup(host, signal) : [publicIP]
    },
    async request(input) {
      requests.push(input)
      return options.request ? options.request(input) : response()
    },
  }
  return { transport, requests, lookups }
}

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-extension-download-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function hangingBody(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }
    },
  }
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveDownloadError)
    return error as ArchiveDownloadError
  }
  throw new Error("Expected an archive failure")
}

describe("extension archive download", () => {
  test("downloads verified raw bytes without creating a staging directory", async () => {
    const f = fixture()
    const result = await downloadArchive({
      url,
      sha256: hash().toUpperCase(),
      directory: "/never/create/this",
      transport: f.transport,
    })
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(result)).toEqual(bytes)
    expect(f.lookups).toEqual(["packages.example.test"])
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]!.address).toBe(publicIP.address)
    expect(f.requests[0]!.family).toBe(4)
  })

  test.each([
    "http://packages.example.test/archive.tgz",
    "https://user:password@packages.example.test/archive.tgz?token=secret",
    "https://@packages.example.test/archive.tgz",
    "https://packages.example.test\\@127.0.0.1/archive.tgz",
    "https:packages.example.test/archive.tgz",
    "https:///packages.example.test/archive.tgz",
    "https://%31%32%37.0.0.1/archive.tgz",
    "https://%70ackages.example.test/archive.tgz",
    "https://2130706433/archive.tgz",
    "https://0x7f000001/archive.tgz",
    "https://0177.0.0.1/archive.tgz",
    "https://127.1/archive.tgz",
    "https://134744072/archive.tgz",
    "https://127.0.0.1/archive.tgz",
    "https://10.1.2.3/archive.tgz",
    "https://100.100.100.200/archive.tgz",
    "https://169.254.169.254/archive.tgz",
    "https://168.63.129.16/archive.tgz",
    "https://172.16.1.1/archive.tgz",
    "https://192.168.1.1/archive.tgz",
    "https://0.0.0.0/archive.tgz",
    "https://224.0.0.1/archive.tgz",
    "https://[::]/archive.tgz",
    "https://[::1]/archive.tgz",
    "https://[fe80::1]/archive.tgz",
    "https://[fd00::1]/archive.tgz",
    "https://[::ffff:127.0.0.1]/archive.tgz",
    "https://[::ffff:808:808]/archive.tgz",
    "https://[64:ff9b::7f00:1]/archive.tgz",
    "https://[2002:7f00:1::]/archive.tgz",
    "https://localhost/archive.tgz",
    "https://foo.localhost./archive.tgz",
    "https://computer.local/archive.tgz",
  ])("rejects unsafe or encoded URL %s before any transport use", async (unsafe) => {
    const f = fixture()
    await expect(downloadArchive({ url: unsafe, sha256: hash(), transport: f.transport })).rejects.toBeInstanceOf(
      ArchiveDownloadError,
    )
    expect(f.lookups).toHaveLength(0)
    expect(f.requests).toHaveLength(0)
  })

  test.each([
    { address: "127.0.0.1", family: 4 },
    { address: "10.0.0.1", family: 4 },
    { address: "169.254.169.254", family: 4 },
    { address: "::1", family: 6 },
    { address: "::ffff:93.184.216.34", family: 6 },
    { address: "2001:db8::1", family: 6 },
    { address: "not-an-address", family: 4 },
    { address: "93.184.216.34", family: 6 },
  ])("rejects all DNS answers if even one answer is unsafe: %j", async (unsafe) => {
    const f = fixture({ lookup: async () => [publicIP, unsafe as DownloadAddress] })
    const error = await failure(downloadArchive({ url, sha256: hash(), transport: f.transport }))
    expect(error.code).toBe("address")
    expect(f.requests).toHaveLength(0)
  })

  test("rejects empty DNS answers", async () => {
    const f = fixture({ lookup: async () => [] })
    await expect(downloadArchive({ url, sha256: hash(), transport: f.transport })).rejects.toThrow("DNS")
    expect(f.requests).toHaveLength(0)
  })

  test("pins a validated answer instead of resolving again during the connection", async () => {
    let calls = 0
    const f = fixture({
      lookup: async () => (++calls === 1 ? [publicIP] : [{ address: "127.0.0.1", family: 4 }]),
      request: async (input) => {
        expect(input.address).toBe(publicIP.address)
        expect(input.url.hostname).toBe("packages.example.test")
        return response()
      },
    })
    await downloadArchive({ url, sha256: hash(), transport: f.transport })
    expect(calls).toBe(1)
  })

  test("validates public IPv6 and uses literals without DNS", async () => {
    const f = fixture()
    await downloadArchive({ url: "https://[2606:4700:4700::1111]/archive", sha256: hash(), transport: f.transport })
    expect(f.lookups).toHaveLength(0)
    expect(f.requests[0]!.address).toBe("2606:4700:4700::1111")
    expect(f.requests[0]!.family).toBe(6)
  })

  test("follows at most three manual redirects, validating and cancelling each hop", async () => {
    let canceled = 0
    const f = fixture({
      request: async () =>
        response({
          status: f.requests.length <= 3 ? 302 : 200,
          headers: f.requests.length <= 3 ? { location: `/hop-${f.requests.length}` } : {},
          cancel: () => {
            canceled++
          },
        }),
    })
    expect(Buffer.from(await downloadArchive({ url, sha256: hash(), transport: f.transport }))).toEqual(bytes)
    expect(f.requests.map((r) => r.url.pathname)).toEqual(["/archive.tgz", "/hop-1", "/hop-2", "/hop-3"])
    expect(f.lookups).toHaveLength(4)
    expect(canceled).toBe(4)
  })

  test("rejects redirect loops after three hops", async () => {
    let canceled = 0
    const f = fixture({
      request: async () =>
        response({
          status: 307,
          headers: { Location: url },
          cancel: () => {
            canceled++
          },
        }),
    })
    expect((await failure(downloadArchive({ url, sha256: hash(), transport: f.transport }))).code).toBe("redirect")
    expect(f.requests).toHaveLength(4)
    expect(canceled).toBe(4)
  })

  test.each([
    "http://packages.example.test/next",
    "https://127.0.0.1/next",
    "https://[::ffff:7f00:1]/next",
    "https://user:secret@packages.example.test/next",
    "//169.254.169.254/latest/meta-data",
    "https://%38.8.8.8/next",
  ])("rejects unsafe redirect %s", async (location) => {
    const f = fixture({ request: async () => response({ status: 302, headers: { location } }) })
    await expect(downloadArchive({ url, sha256: hash(), transport: f.transport })).rejects.toBeInstanceOf(
      ArchiveDownloadError,
    )
    expect(f.requests).toHaveLength(1)
  })

  test("rechecks DNS on redirect and rejects rebinding to a private answer", async () => {
    let calls = 0
    const f = fixture({
      lookup: async () => (++calls === 1 ? [publicIP] : [{ address: "127.0.0.1", family: 4 }]),
      request: async () => response({ status: 302, headers: { location: "/again" } }),
    })
    expect((await failure(downloadArchive({ url, sha256: hash(), transport: f.transport }))).code).toBe("address")
    expect(f.requests).toHaveLength(1)
  })

  test.each([301, 302, 303, 307, 308])("handles redirect status %s explicitly", async (status) => {
    const f = fixture({
      request: async () =>
        f.requests.length === 1
          ? response({ status, headers: { location: "https://other.example.test/archive" } })
          : response(),
    })
    await downloadArchive({ url, sha256: hash(), transport: f.transport })
    expect(f.lookups).toEqual(["packages.example.test", "other.example.test"])
  })

  test("rejects missing redirect locations and unsuccessful responses", async () => {
    for (const status of [302, 204, 206, 304, 404, 500]) {
      const f = fixture({ request: async () => response({ status }) })
      await expect(downloadArchive({ url, sha256: hash(), transport: f.transport })).rejects.toBeInstanceOf(
        ArchiveDownloadError,
      )
    }
  })

  test("requires a strict SHA-256 before network work and detects hash mismatch", async () => {
    for (const sha256 of [undefined, "", "a".repeat(63), "g".repeat(64), ` ${hash()}`, `${hash()}\n`]) {
      const f = fixture()
      await expect(downloadArchive({ url, sha256: sha256 as string, transport: f.transport })).rejects.toThrow(
        "SHA-256",
      )
      expect(f.lookups).toHaveLength(0)
    }
    const f = fixture()
    expect((await failure(downloadArchive({ url, sha256: "0".repeat(64), transport: f.transport }))).code).toBe(
      "integrity",
    )
  })

  test("supports npm SHA-512 SRI and rejects missing, malformed and mismatched integrity", async () => {
    const f = fixture()
    expect(Buffer.from(await downloadPackage({ url, integrity: integrity(), transport: f.transport }))).toEqual(bytes)
    for (const value of ["", "sha1-deadbeef", "sha512-abc", integrity(Buffer.from("other"))]) {
      await expect(downloadPackage({ url, integrity: value, transport: f.transport })).rejects.toBeInstanceOf(
        ArchiveDownloadError,
      )
    }
    const alternatives = `${integrity(Buffer.from("other"))} ${integrity()}`
    expect(Buffer.from(await downloadPackage({ url, integrity: alternatives, transport: f.transport }))).toEqual(bytes)
  })

  test("uses strongest npm SRI algorithm and never downgrades to a matching weaker digest", async () => {
    for (const algorithm of ["sha256", "sha384", "sha512"]) {
      const f = fixture()
      const value = `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`
      expect(Buffer.from(await downloadPackage({ url, integrity: value, transport: f.transport }))).toEqual(bytes)
    }
    const f = fixture()
    const weaker = `sha256-${createHash("sha256").update(bytes).digest("base64")}`
    await expect(
      downloadPackage({
        url,
        integrity: `${weaker} ${integrity(Buffer.from("different"))}`,
        transport: f.transport,
      }),
    ).rejects.toThrow("integrity mismatch")
  })

  test("hashes compressed bytes without content-encoding decompression", async () => {
    const compressed = gzipSync(bytes)
    const f = fixture({
      request: async () =>
        response({
          headers: { "content-encoding": "gzip" },
          body: (async function* () {
            yield compressed
          })(),
        }),
    })
    expect(Buffer.from(await downloadArchive({ url, sha256: hash(compressed), transport: f.transport }))).toEqual(
      compressed,
    )
  })

  test("limits content-length and streamed bytes, even if declared length is false", async () => {
    let canceled = 0
    const large = fixture({
      request: async () =>
        response({
          headers: { "content-length": "101" },
          cancel: () => {
            canceled++
          },
        }),
    })
    await expect(
      downloadArchive({ url, sha256: hash(), limits: { maxBytes: 100 }, transport: large.transport }),
    ).rejects.toThrow("byte limit")
    expect(canceled).toBe(1)
    const lying = fixture({
      request: async () =>
        response({
          headers: { "content-length": "1" },
          body: (async function* () {
            yield Buffer.alloc(3)
            yield Buffer.alloc(3)
          })(),
          cancel: () => {
            canceled++
          },
        }),
    })
    await expect(
      downloadArchive({ url, sha256: hash(), limits: { maxBytes: 5 }, transport: lying.transport }),
    ).rejects.toThrow("byte limit")
    expect(canceled).toBe(2)
  })

  test("enforces the hard 100MiB compressed limit using content-length without allocation", async () => {
    const f = fixture({
      request: async () => response({ headers: { "content-length": String(100 * 1024 * 1024 + 1) } }),
    })
    await expect(downloadArchive({ url, sha256: hash(), transport: f.transport })).rejects.toThrow("byte limit")
  })

  test.each([
    { maxBytes: -1 },
    { maxBytes: NaN },
    { maxBytes: 100 * 1024 * 1024 + 1 },
    { timeoutMs: 0 },
    { timeoutMs: 120001 },
    { maxRedirects: 4 },
    { maxRedirects: 1.5 },
  ])("does not allow limits to exceed the safety ceilings: %j", async (limits) => {
    const f = fixture()
    await expect(downloadArchive({ url, sha256: hash(), limits, transport: f.transport })).rejects.toThrow("limit")
    expect(f.requests).toHaveLength(0)
  })

  test("rejects malformed content-length and duplicate security-sensitive headers", async () => {
    for (const headers of [{ "content-length": "NaN" }, { "content-length": ["1", "2"] }]) {
      const f = fixture({ request: async () => response({ headers }) })
      await expect(downloadArchive({ url, sha256: hash(), transport: f.transport })).rejects.toBeInstanceOf(
        ArchiveDownloadError,
      )
    }
  })

  test("pre-aborted signals do not call the transport or expose abort reason", async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort(new Error("https://user:password@host/?token=private-token"))
    const error = await failure(
      downloadArchive({ url, sha256: hash(), signal: controller.signal, transport: f.transport }),
    )
    expect(error.name).toBe("AbortError")
    expect(error.message).not.toContain("private-token")
    expect(f.lookups).toHaveLength(0)
  })

  test("abort stops waiting for an uncooperative DNS resolver", async () => {
    const controller = new AbortController()
    const f = fixture({ lookup: () => new Promise(() => {}) })
    const promise = downloadArchive({ url, sha256: hash(), signal: controller.signal, transport: f.transport })
    controller.abort()
    expect((await failure(promise)).code).toBe("aborted")
    expect(f.requests).toHaveLength(0)
  })

  test("timeout includes DNS and connection/header acquisition", async () => {
    const dns = fixture({ lookup: () => new Promise(() => {}) })
    const connect = fixture({ request: () => new Promise(() => {}) })
    for (const f of [dns, connect]) {
      const error = await failure(
        downloadArchive({ url, sha256: hash(), limits: { timeoutMs: 10 }, transport: f.transport }),
      )
      expect(error.code).toBe("timeout")
      expect(error.name).toBe("TimeoutError")
    }
  })

  test("timeout and abort cancel a stalled body", async () => {
    for (const abort of [false, true]) {
      let canceled = 0
      const controller = new AbortController()
      const f = fixture({
        request: async () =>
          response({
            body: hangingBody(),
            cancel: () => {
              canceled++
            },
          }),
      })
      const promise = downloadArchive({
        url,
        sha256: hash(),
        signal: controller.signal,
        limits: { timeoutMs: abort ? 1000 : 10 },
        transport: f.transport,
      })
      const timer = abort ? setTimeout(() => controller.abort(), 10) : undefined
      try {
        expect((await failure(promise)).code).toBe(abort ? "aborted" : "timeout")
        expect(canceled).toBe(1)
      } finally {
        clearTimeout(timer)
      }
    }
  })

  test("cancels late responses after abort without leaking an unhandled rejection", async () => {
    let canceled = 0
    let release: (value: DownloadResponse) => void = () => {}
    const f = fixture({
      request: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })
    const promise = downloadArchive({ url, sha256: hash(), limits: { timeoutMs: 10 }, transport: f.transport })
    expect((await failure(promise)).code).toBe("timeout")
    release(
      response({
        cancel: () => {
          canceled++
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(canceled).toBe(1)
  })

  test("redacts errors from DNS, TLS/request, stream and cleanup", async () => {
    const secret = "https://user:password@packages.example.test/path?token=private-token"
    for (const where of ["dns", "request", "body"] as const) {
      const f = fixture({
        lookup: async () => {
          if (where === "dns") throw new Error(secret)
          return [publicIP]
        },
        request: async () => {
          if (where === "request") throw new Error(secret)
          return response({
            body: (async function* () {
              throw new Error(secret)
            })(),
            cancel: () => {
              throw new Error(secret)
            },
          })
        },
      })
      const error = await failure(downloadArchive({ url, sha256: hash(), transport: f.transport }))
      expect(error.code).toBe("network")
      expect(String(error)).not.toContain("private-token")
      expect(String(error)).not.toContain("password")
      expect(error.cause).toBeUndefined()
    }
  })

  test("requestJson uses the same safe pinned download and bounded strict JSON parsing", async () => {
    const json = Buffer.from('{"name":"safe-package"}')
    const f = fixture({
      request: async () =>
        response({
          body: (async function* () {
            yield json
          })(),
        }),
    })
    expect(await requestJson(url, { transport: f.transport })).toEqual({ name: "safe-package" })
    expect(f.requests[0]!.address).toBe(publicIP.address)
    await expect(requestJson(url, { maxBytes: 1, transport: f.transport })).rejects.toThrow("byte limit")
    const invalid = fixture()
    await expect(requestJson(url, { transport: invalid.transport })).rejects.toThrow("metadata JSON")
    const large = fixture({
      request: async () => response({ headers: { "content-length": String(4 * 1024 * 1024 + 1) } }),
    })
    await expect(requestJson(url, { transport: large.transport })).rejects.toThrow("byte limit")
    await expect(requestJson(url, { maxBytes: 16 * 1024 * 1024 + 1, transport: f.transport })).rejects.toThrow("limit")
    const privateHost = fixture()
    await expect(requestJson("https://127.0.0.1/data", { transport: privateHost.transport })).rejects.toThrow(
      "routable",
    )
    expect(privateHost.requests).toHaveLength(0)
  })
})

describe("local extension archive", () => {
  test("reads a copy, verifies its hash and never modifies or deletes the source", async () =>
    temporary(async (directory) => {
      const file = path.join(directory, "archive.tgz")
      await writeFile(file, bytes)
      expect(Buffer.from(await readLocalArchive({ file, sha256: hash() }))).toEqual(bytes)
      expect(Buffer.from(await copyLocalArchive({ file, sha256: hash() }))).toEqual(bytes)
      await expect(readLocalArchive({ file, sha256: "0".repeat(64) })).rejects.toThrow("integrity mismatch")
      await expect(readLocalArchive({ file, sha256: hash(), maxBytes: bytes.length - 1 })).rejects.toThrow("byte limit")
      expect(await readFile(file)).toEqual(bytes)
    }))

  test("rejects malformed hashes, non-files, symbolic links and missing files without unlinking", async () =>
    temporary(async (directory) => {
      const file = path.join(directory, "archive.tgz")
      await writeFile(file, bytes)
      const link = path.join(directory, "link.tgz")
      await symlink(file, link)
      await expect(readLocalArchive({ file, sha256: "" })).rejects.toThrow("SHA-256")
      await expect(readLocalArchive({ file: directory, sha256: hash() })).rejects.toThrow("regular local file")
      await expect(readLocalArchive({ file: link, sha256: hash() })).rejects.toThrow("Could not read")
      await expect(
        readLocalArchive({ file: path.join(directory, "missing-secret-token"), sha256: hash() }),
      ).rejects.toThrow("Could not read")
      expect(await readFile(file)).toEqual(bytes)
      expect(await readFile(link)).toEqual(bytes)
    }))

  test("local reads honor cancellation without deleting the original", async () =>
    temporary(async (directory) => {
      const file = path.join(directory, "archive.tgz")
      await writeFile(file, bytes)
      const controller = new AbortController()
      controller.abort(new Error("private-token"))
      const error = await failure(readLocalArchive({ file, sha256: hash(), signal: controller.signal }))
      expect(error.name).toBe("AbortError")
      expect(error.message).not.toContain("private-token")
      expect(await readFile(file)).toEqual(bytes)
    }))

  test("allows an empty archive only when its SHA-256 matches", async () =>
    temporary(async (directory) => {
      const file = path.join(directory, "empty.tgz")
      await writeFile(file, "")
      expect((await readLocalArchive({ file, sha256: hash(Buffer.alloc(0)), maxBytes: 0 })).length).toBe(0)
    }))
})
