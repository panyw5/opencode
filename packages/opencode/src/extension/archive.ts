import path from "node:path"
import { constants } from "node:fs"
import { lstat, mkdir, open, rm } from "node:fs/promises"
import { Readable, Transform, type TransformCallback } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import tar from "tar-stream"

export type ArchiveLimits = {
  compressedBytes: number
  inflatedBytes: number
  fileBytes: number
  entries: number
  depth: number
  pathBytes: number
  metadataBytes: number
}

export const archiveLimits: Readonly<ArchiveLimits> = Object.freeze({
  compressedBytes: 100 * 1024 * 1024,
  inflatedBytes: 512 * 1024 * 1024,
  fileBytes: 128 * 1024 * 1024,
  entries: 20_000,
  depth: 32,
  pathBytes: 1024,
  metadataBytes: 1024 * 1024,
})

export type ExtractArchiveOptions = {
  input: Uint8Array | Readable
  /** Must not exist; its parent must already exist and have no symbolic-link ancestors. */
  directory: string
  signal?: AbortSignal
  limits?: Partial<ArchiveLimits>
  policy?: "archive" | "npm"
}

const forbidden = new Set([
  "node_modules",
  ".npmrc",
  ".git",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
])

function fail(message: string): never {
  throw new Error(`Invalid extension archive: ${message}`)
}

function archivePath(name: string, directory: boolean, limits: ArchiveLimits) {
  if (Buffer.byteLength(name) > limits.pathBytes) fail("path limit exceeded")
  if (/[\\\x00-\x1f\x7f:<>"|?*]/.test(name) || name.startsWith("/")) fail("unsafe path")
  const value = directory && name.endsWith("/") ? name.slice(0, -1) : name
  const parts = value.split("/")
  if (parts[0] !== "package") fail("expected package/ root")
  if (parts.length - 1 > limits.depth) fail("depth limit exceeded")
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[. ]$/.test(part)) fail("unsafe path component")
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) fail("reserved Windows name")
    if (forbidden.has(part.toLowerCase())) fail(`forbidden path component: ${part}`)
  }
  if (parts.length === 1 && !directory) fail("package root must be a directory")
  return parts.slice(1)
}

function countBytes(limit: number, label: string) {
  let bytes = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      callback(bytes > limit ? new Error(`Invalid extension archive: ${label} limit exceeded`) : null, chunk)
    },
  })
}

function sizeField(header: Buffer) {
  const field = header.subarray(124, 136)
  if (field[0] & 0x80) {
    if (field[0] !== 0x80) fail("invalid tar size")
    let result = 0
    for (const value of field.subarray(1)) {
      result = result * 256 + value
      if (!Number.isSafeInteger(result)) fail("invalid tar size")
    }
    return result
  }
  const value = field.toString("ascii").replace(/\0.*$/, "").trim()
  if (!/^[0-7]+$/.test(value)) fail("invalid tar size")
  const result = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(result)) fail("invalid tar size")
  return result
}

/** Bounds hidden PAX/GNU metadata before tar-stream buffers it, and requires a complete tar terminator. */
class TarGuard extends Transform {
  private header = Buffer.alloc(512)
  private filled = 0
  private remaining = 0
  private padding = 0
  private metadata: Buffer[] | undefined
  private metadataSize = 0
  private metadataTotal = 0
  private metadataType = ""
  private pendingSize: number | undefined
  private pendingMetadata = false
  private entries = 0
  private zeros = 0

  constructor(private limits: ArchiveLimits) {
    super()
  }

  private readHeader() {
    if (this.header.every((value) => value === 0)) {
      this.zeros++
      return
    }
    if (this.zeros) fail("data after tar terminator")
    if (++this.entries > this.limits.entries) fail("entry count limit exceeded")
    const type = String.fromCharCode(this.header[156])
    const metadata = type === "x" || type === "L"
    if (!metadata && type !== "0" && type !== "\0" && type !== "5") fail("unsupported entry type")
    const rawSize = sizeField(this.header)
    const size = metadata ? rawSize : (this.pendingSize ?? rawSize)
    if (metadata) {
      if (this.pendingMetadata) fail("stacked metadata headers")
      this.metadataTotal += size
      if (this.metadataTotal > this.limits.metadataBytes) fail("metadata limit exceeded")
      this.metadata = []
      this.metadataSize = size
      this.metadataType = type
      this.pendingMetadata = true
    } else {
      this.pendingSize = undefined
      this.pendingMetadata = false
      if (size > this.limits.fileBytes) fail("single file limit exceeded")
      if (type === "5" && size !== 0) fail("directory has a body")
    }
    this.remaining = size
    this.padding = (512 - (size % 512)) % 512
    if (metadata && size === 0) fail("empty metadata")
  }

  private readMetadata() {
    const data = Buffer.concat(this.metadata!, this.metadataSize)
    this.metadata = undefined
    if (this.metadataType === "L") {
      const name = data.toString("utf8").replace(/\0$/, "")
      archivePath(name, name.endsWith("/"), this.limits)
      return
    }
    let offset = 0
    while (offset < data.length) {
      const space = data.indexOf(32, offset)
      if (space === -1) fail("invalid PAX record")
      const length = data.toString("ascii", offset, space)
      if (!/^[1-9][0-9]*$/.test(length)) fail("invalid PAX record")
      const end = offset + Number(length)
      if (!Number.isSafeInteger(end) || end > data.length || end <= space + 2 || data[end - 1] !== 10)
        fail("invalid PAX record")
      const record = data.toString("utf8", space + 1, end - 1)
      const equals = record.indexOf("=")
      if (equals <= 0) fail("invalid PAX record")
      const key = record.slice(0, equals)
      const value = record.slice(equals + 1)
      // tar-stream applies the final value for repeated keys; validate every path value conservatively.
      if (/sparse|realsize|filetype/i.test(key)) fail("sparse metadata is forbidden")
      if (key === "path") archivePath(value, value.endsWith("/"), this.limits)
      if (key === "linkpath") fail("link metadata is forbidden")
      if (key === "size") {
        if (!/^(0|[1-9][0-9]*)$/.test(value)) fail("invalid PAX size")
        this.pendingSize = Number(value)
        if (!Number.isSafeInteger(this.pendingSize)) fail("invalid PAX size")
      }
      offset = end
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    try {
      let offset = 0
      while (offset < chunk.length) {
        if (this.remaining) {
          const length = Math.min(this.remaining, chunk.length - offset)
          if (this.metadata) this.metadata.push(Buffer.from(chunk.subarray(offset, offset + length)))
          this.remaining -= length
          offset += length
          if (!this.remaining && this.metadata) this.readMetadata()
          continue
        }
        if (this.padding) {
          const length = Math.min(this.padding, chunk.length - offset)
          this.padding -= length
          offset += length
          continue
        }
        const length = Math.min(512 - this.filled, chunk.length - offset)
        chunk.copy(this.header, this.filled, offset, offset + length)
        this.filled += length
        offset += length
        if (this.filled === 512) {
          this.filled = 0
          this.readHeader()
        }
      }
      callback(null, chunk)
    } catch (error) {
      callback(error as Error)
    }
  }

  override _flush(callback: TransformCallback) {
    callback(
      this.filled || this.remaining || this.padding || this.pendingMetadata || this.zeros < 2
        ? new Error("Invalid extension archive: truncated tar")
        : null,
    )
  }
}

async function ordinaryDirectory(directory: string) {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("parent is not an ordinary directory")
  return stat
}

async function parentChain(directory: string) {
  const parent = path.dirname(directory)
  if (parent !== directory) await parentChain(parent)
  await ordinaryDirectory(directory)
}

/** Extracts a gzip-compressed npm-layout tar without running code or preserving archive modes/ownership.
 * Returns actual regular-file content bytes and regular-file count. Both policies reject bundled dependencies.
 */
export async function extractArchive(options: ExtractArchiveOptions): Promise<{ bytes: number; files: number }> {
  const limits = { ...archiveLimits, ...options.limits }
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid limits")
  }
  if (options.policy && options.policy !== "archive" && options.policy !== "npm") fail("invalid policy")
  options.signal?.throwIfAborted()
  const directory = path.resolve(options.directory)
  await parentChain(path.dirname(directory))
  await mkdir(directory, { mode: 0o700 })
  const owned = await lstat(directory)
  let active: Promise<void> | undefined
  try {
    options.signal?.throwIfAborted()
    const source = options.input instanceof Uint8Array ? Readable.from([options.input]) : options.input
    const extract = tar.extract()
    const seen = new Map<string, { name: string; directory: boolean; explicit: boolean }>()
    let bytes = 0
    let files = 0
    extract.on("entry", (header, stream, next) => {
      stream.on("error", () => {})
      active = (async () => {
        options.signal?.throwIfAborted()
        const isDirectory = header.type === "directory"
        if (!isDirectory && header.type !== "file") fail("unsupported entry type")
        const size = header.size
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > limits.fileBytes)
          fail("single file limit exceeded")
        if (isDirectory && size) fail("directory has a body")
        const parts = archivePath(header.name, isDirectory, limits)
        for (let index = 0; index <= parts.length; index++) {
          const name = parts.slice(0, index).join("/")
          const key = name.normalize("NFC").toLowerCase()
          const last = index === parts.length
          const dir = !last || isDirectory
          const previous = seen.get(key)
          if (previous && previous.name !== name) fail("case or Unicode path collision")
          if (previous && (!previous.directory || !dir || (last && previous.explicit))) fail("duplicate path")
          if (!previous) seen.set(key, { name, directory: dir, explicit: last })
          else if (last) previous.explicit = true
          const target = path.join(directory, ...parts.slice(0, index))
          if (!dir) continue
          if (index && !previous) await mkdir(target, { mode: 0o700 })
          await ordinaryDirectory(target)
        }
        if (isDirectory) {
          for await (const chunk of stream) {
            if (chunk.length) fail("directory has a body")
          }
          return
        }
        const file = await open(
          path.join(directory, ...parts),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
        try {
          let written = 0
          for await (const chunk of stream) {
            options.signal?.throwIfAborted()
            written += chunk.length
            if (written > limits.fileBytes || written > size) fail("single file limit exceeded")
            await file.writeFile(chunk)
          }
          if (written !== size) fail("truncated file")
          bytes += written
          files++
        } finally {
          await file.close()
        }
      })()
      active.then(
        () => next(),
        (error) => next(error),
      )
    })
    // Explicit destruction also interoperates with tar-stream's streamx Writable on Bun.
    const abort = () => source.destroy(new DOMException("Archive extraction aborted", "AbortError"))
    options.signal?.addEventListener("abort", abort, { once: true })
    try {
      const extracting = pipeline(
        source,
        countBytes(limits.compressedBytes, "compressed bytes"),
        createGunzip(),
        countBytes(limits.inflatedBytes, "inflated bytes"),
        new TarGuard(limits),
        extract,
      )
      if (options.signal?.aborted) abort()
      await extracting
    } finally {
      options.signal?.removeEventListener("abort", abort)
    }
    await active
    options.signal?.throwIfAborted()
    return { bytes, files }
  } catch (error) {
    await active?.catch(() => {})
    // Never remove a preexisting destination or a replacement installed by someone else.
    const current = await lstat(directory).catch(() => undefined)
    if (current?.isDirectory() && current.dev === owned.dev && current.ino === owned.ino)
      await rm(directory, { recursive: true, force: true })
    throw error
  }
}
