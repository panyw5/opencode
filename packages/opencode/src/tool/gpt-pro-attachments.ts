import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Cause, Effect } from "effect"
import type { GptProAttachment } from "@opencode-ai/util/gpt-pro"
import { InstanceState } from "@/effect/instance-state"
import { sniffAttachmentMime } from "@/util/media"
import type * as Tool from "./tool"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.gpt_pro_attachments" })
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_FILE_BYTES / 3)
const SAMPLE_BYTES = 4096
const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
}
const MAX_SOURCE_COUNT = 50
const MAX_ATTACHMENT_NAME_BYTES = 240
const MAX_ATTACHMENT_PATH_CHARS = 4096

type DirectFilePart = {
  type: "file"
  mime: string
  url: string
  filename?: string
  source?: { type?: string; path?: string }
}

type Candidate = {
  name: string
  path?: string
  canonical?: string
  bytes?: Buffer
  mime: string
  originalPath: boolean
  size: number
  dev?: number
  ino?: number
}

function plainFilename(input: string) {
  if (input.includes("\0")) throw new Error("Attachment filename contains invalid characters")
  const name = path.posix.basename(input.replaceAll("\\", "/")).trim()
  if (!name || name === "." || name === "..") throw new Error("Attachment filename is invalid")
  if (Buffer.byteLength(name, "utf8") > MAX_ATTACHMENT_NAME_BYTES) {
    throw new Error("Attachment filename exceeds 240 bytes")
  }
  return name
}

function partFilename(part: DirectFilePart) {
  if (part.filename?.trim()) return plainFilename(part.filename)
  if (part.source?.path) return plainFilename(path.basename(part.source.path))
  const url = typeof part.url === "string" ? part.url : ""
  if (url.startsWith("file:")) return plainFilename(path.basename(pathFromFileURL(url, "attachment")))
  const declared = /^data:([^;,]+);base64,/.exec(url)?.[1]?.trim().toLowerCase()
  const extension = Object.entries(MIME_BY_EXTENSION).find(([, mime]) => mime === declared)?.[0]
  return `attachment${extension ?? ""}`
}

function pathFromFileURL(value: string, name: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "file:") throw new Error()
    url.search = ""
    url.hash = ""
    return fileURLToPath(url)
  } catch {
    throw new Error(`GPT-Pro attachment URL is invalid: ${name}`)
  }
}

function dataBytes(part: DirectFilePart, name: string) {
  const data = /^data:([^;,]+);base64,([\s\S]*)$/.exec(part.url)
  if (!data) throw new Error(`GPT-Pro attachment source is unsupported: ${name}`)
  const mime = data[1]!.trim().toLowerCase()
  const encoded = data[2]!
  const extensions = Object.entries(MIME_BY_EXTENSION)
    .filter(([, extensionMime]) => extensionMime === mime)
    .map(([extension]) => extension)
  if (mime === "text/plain") extensions.push(".md")
  if (
    extensions.length === 0 ||
    encoded.length > MAX_BASE64_CHARS ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error(`Unsupported or malformed GPT-Pro attachment: ${name}`)
  }
  const extension = path.extname(name).toLowerCase()
  if (extension && !extensions.includes(extension)) {
    throw new Error(`GPT-Pro attachment filename does not match its declared media type: ${name}`)
  }
  const selectedExtension = extension || extensions[0]!
  const canonicalMime = MIME_BY_EXTENSION[selectedExtension]!
  const partMime = part.mime.trim().toLowerCase()
  const markdownAlias = selectedExtension === ".md" && ["text/plain", "text/markdown"].includes(partMime)
  if (partMime !== mime && !markdownAlias) {
    throw new Error(`GPT-Pro attachment media type does not match its data URL: ${name}`)
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  const decodedLength = (encoded.length * 3) / 4 - padding
  if (decodedLength > MAX_FILE_BYTES) throw new Error(`GPT-Pro attachment exceeds 20 MB: ${name}`)
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength !== decodedLength || bytes.toString("base64") !== encoded) {
    throw new Error(`Malformed GPT-Pro attachment data: ${name}`)
  }
  return { bytes, mime: canonicalMime, extension: selectedExtension }
}

async function resolvePath(input: string, name: string) {
  let canonical: string
  try {
    canonical = await realpath(input)
  } catch {
    throw new Error(`GPT-Pro attachment not found: ${name}`)
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(canonical)
  } catch {
    throw new Error(`Unable to inspect GPT-Pro attachment: ${name}`)
  }
  if (!info.isFile()) throw new Error(`GPT-Pro attachment must be a regular file: ${name}`)
  if (info.size > MAX_FILE_BYTES) throw new Error(`GPT-Pro attachment exceeds 20 MB: ${name}`)
  const extension = path.extname(name).toLowerCase()
  const mime = MIME_BY_EXTENSION[extension]
  if (!mime) throw new Error(`Unsupported GPT-Pro attachment type: ${name}`)
  return { canonical, size: info.size, dev: Number(info.dev), ino: Number(info.ino), mime }
}

async function inspectFile(filepath: string, expected: Candidate, signal: AbortSignal) {
  const hash = createHash("sha256")
  let sample = Buffer.alloc(0)
  let bytes = 0
  const handle = await open(filepath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.size > MAX_FILE_BYTES ||
      opened.size !== expected.size ||
      (expected.dev !== undefined && Number(opened.dev) !== expected.dev) ||
      (expected.ino !== undefined && Number(opened.ino) !== expected.ino)
    ) {
      throw new Error(`GPT-Pro attachment changed after validation: ${expected.name}`)
    }
    const textDecoder = expected.mime.startsWith("text/") ? new TextDecoder("utf-8", { fatal: true }) : undefined
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal })
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > MAX_FILE_BYTES) throw new Error(`GPT-Pro attachment exceeds 20 MB during read: ${expected.name}`)
      if (textDecoder) {
        if (chunk.includes(0)) throw new Error(`GPT-Pro text attachment contains binary data: ${expected.name}`)
        textDecoder.decode(chunk, { stream: true })
      }
      if (sample.length < SAMPLE_BYTES)
        sample = Buffer.concat([sample, chunk.subarray(0, SAMPLE_BYTES - sample.length)])
      hash.update(chunk)
    }
    textDecoder?.decode()
    if (bytes !== opened.size) throw new Error(`GPT-Pro attachment changed while being read: ${expected.name}`)
    const after = await handle.stat()
    if (
      Number(after.dev) !== Number(opened.dev) ||
      Number(after.ino) !== Number(opened.ino) ||
      after.size !== opened.size
    ) {
      throw new Error(`GPT-Pro attachment changed while being read: ${expected.name}`)
    }
    return { sha256: hash.digest("hex"), sample }
  } finally {
    await handle.close()
  }
}

/** Resolve, authorize, and inspect every explicit GPT-Pro attachment as one scoped operation. */
const prepareGptProAttachmentsImpl = Effect.fn("GptProAttachments.prepare")(function* (
  paths: readonly string[] | undefined,
  ctx: Tool.Context,
  target: string,
) {
  const rawDirectParts = ctx.extra?.gptProAttachmentParts
  if (rawDirectParts !== undefined && !Array.isArray(rawDirectParts)) {
    return yield* Effect.die(new Error("GPT-Pro attachment descriptors are invalid"))
  }
  const directParts = (rawDirectParts ?? []) as readonly DirectFilePart[]
  const sourceCount = (paths?.length ?? 0) + directParts.length
  log.info("attachment source resolution started", { count: sourceCount, target })
  if (sourceCount > MAX_SOURCE_COUNT) return yield* Effect.die(new Error("Too many GPT-Pro attachment sources"))
  if (sourceCount === 0) return [] as GptProAttachment[]

  const instance = yield* InstanceState.context
  const candidates: Candidate[] = []
  const seenPaths = new Set<string>()
  let total = 0
  const inputs: Array<{ kind: "path"; value: string } | { kind: "part"; value: DirectFilePart }> = [
    ...(paths ?? []).map((value) => ({ kind: "path" as const, value })),
    ...directParts.map((value) => ({ kind: "part" as const, value })),
  ]

  for (const input of inputs) {
    if (input.kind === "path") {
      const value = input.value
      if (!value || value.length > MAX_ATTACHMENT_PATH_CHARS || value.includes("\0")) {
        return yield* Effect.die(new Error("Invalid GPT-Pro attachment path"))
      }
      const name = plainFilename(
        value.startsWith("file:") ? path.basename(pathFromFileURL(value, "attachment")) : value,
      )
      const absolute = value.startsWith("file:")
        ? pathFromFileURL(value, name)
        : path.isAbsolute(value)
          ? value
          : path.resolve(instance.directory, value)
      const resolved = yield* Effect.tryPromise({
        try: () => resolvePath(absolute, name),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.orDie)
      if (seenPaths.has(resolved.canonical)) {
        log.info("duplicate attachment path skipped", { name })
        continue
      }
      if (candidates.length >= 10) return yield* Effect.die(new Error("GPT-Pro accepts at most 10 attachments"))
      if (total + resolved.size > MAX_TOTAL_BYTES) {
        return yield* Effect.die(new Error(`GPT-Pro attachments exceed 50 MB total at ${name}`))
      }
      seenPaths.add(resolved.canonical)
      total += resolved.size
      candidates.push({
        name,
        path: absolute,
        canonical: resolved.canonical,
        mime: resolved.mime,
        originalPath: true,
        size: resolved.size,
        dev: resolved.dev,
        ino: resolved.ino,
      })
      log.info("local attachment validated", { name, size: resolved.size })
      continue
    }

    const part = input.value
    if (part.type !== "file") {
      return yield* Effect.die(new Error("GPT-Pro attachment descriptor is invalid"))
    }
    if (typeof part.url !== "string" || part.url.length > 30 * 1024 * 1024) {
      return yield* Effect.die(new Error("GPT-Pro attachment URL is invalid"))
    }
    if (part.source?.path && (part.source.path.length > MAX_ATTACHMENT_PATH_CHARS || part.source.path.includes("\0"))) {
      return yield* Effect.die(new Error(`GPT-Pro attachment source path is invalid: ${part.filename ?? "attachment"}`))
    }
    const name = partFilename(part)
    if (part.source && part.source.type !== "file" && part.source.type !== "symbol") {
      return yield* Effect.die(new Error(`GPT-Pro attachment source is not a local file: ${name}`))
    }
    if (part.source && !part.source.path) {
      return yield* Effect.die(new Error(`GPT-Pro attachment source path is missing: ${name}`))
    }
    if (part.source?.path) {
      const fromSource = path.isAbsolute(part.source.path)
        ? part.source.path
        : path.resolve(instance.directory, part.source.path)
      const fromUrl = part.url.startsWith("file:") ? pathFromFileURL(part.url, name) : undefined
      if (part.url.startsWith("data:")) {
        return yield* Effect.die(new Error(`GPT-Pro attachment source does not match its data URL: ${name}`))
      }
      if (part.url && !fromUrl) {
        return yield* Effect.die(new Error(`GPT-Pro attachment URL is unsupported: ${name}`))
      }
      const sourceResolved = yield* Effect.tryPromise({
        try: () => resolvePath(fromSource, name),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.orDie)
      if (fromUrl) {
        const urlResolved = yield* Effect.tryPromise({
          try: () => realpath(fromUrl),
          catch: () => new Error(`GPT-Pro attachment URL target not found: ${name}`),
        }).pipe(Effect.orDie)
        if (urlResolved !== sourceResolved.canonical) {
          return yield* Effect.die(new Error(`GPT-Pro attachment source and URL identify different files: ${name}`))
        }
      }
      if (seenPaths.has(sourceResolved.canonical)) {
        log.info("duplicate attachment path skipped", { name })
        continue
      }
      if (candidates.length >= 10) return yield* Effect.die(new Error("GPT-Pro accepts at most 10 attachments"))
      if (total + sourceResolved.size > MAX_TOTAL_BYTES) {
        return yield* Effect.die(new Error(`GPT-Pro attachments exceed 50 MB total at ${name}`))
      }
      seenPaths.add(sourceResolved.canonical)
      total += sourceResolved.size
      candidates.push({
        name,
        path: fromSource,
        canonical: sourceResolved.canonical,
        mime: sourceResolved.mime,
        originalPath: true,
        size: sourceResolved.size,
        dev: sourceResolved.dev,
        ino: sourceResolved.ino,
      })
      log.info("local attachment validated", { name, size: sourceResolved.size })
      continue
    }
    if (part.url.startsWith("file:")) {
      const filepath = pathFromFileURL(part.url, name)
      const resolved = yield* Effect.tryPromise({
        try: () => resolvePath(filepath, name),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.orDie)
      if (seenPaths.has(resolved.canonical)) {
        log.info("duplicate attachment path skipped", { name })
        continue
      }
      if (candidates.length >= 10) return yield* Effect.die(new Error("GPT-Pro accepts at most 10 attachments"))
      if (total + resolved.size > MAX_TOTAL_BYTES) {
        return yield* Effect.die(new Error(`GPT-Pro attachments exceed 50 MB total at ${name}`))
      }
      seenPaths.add(resolved.canonical)
      total += resolved.size
      candidates.push({
        name,
        path: filepath,
        canonical: resolved.canonical,
        mime: resolved.mime,
        originalPath: true,
        size: resolved.size,
        dev: resolved.dev,
        ino: resolved.ino,
      })
      log.info("local attachment validated", { name, size: resolved.size })
      continue
    }
    if (part.source?.path) {
      return yield* Effect.die(new Error(`GPT-Pro attachment source is invalid: ${name}`))
    }
    const decoded = yield* Effect.try({
      try: () => dataBytes(part, name),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(Effect.orDie)
    const finalName = path.extname(name) ? name : `${name}${decoded.extension}`
    if (candidates.length >= 10) return yield* Effect.die(new Error("GPT-Pro accepts at most 10 attachments"))
    if (total + decoded.bytes.byteLength > MAX_TOTAL_BYTES) {
      return yield* Effect.die(new Error(`GPT-Pro attachments exceed 50 MB total at ${finalName}`))
    }
    total += decoded.bytes.byteLength
    candidates.push({
      name: finalName,
      bytes: decoded.bytes,
      mime: decoded.mime,
      originalPath: false,
      size: decoded.bytes.byteLength,
    })
    log.info("in-memory attachment validated", { name: finalName, size: decoded.bytes.byteLength })
  }

  if (total !== candidates.reduce((sum, item) => sum + item.size, 0)) {
    return yield* Effect.die(new Error("GPT-Pro attachment size accounting failed"))
  }

  log.info("attachment authorization started", { count: candidates.length, totalBytes: total, target })
  for (const item of candidates) {
    if (!item.originalPath) continue
    const canonical = item.canonical!
    yield* assertExternalDirectoryEffect(ctx, canonical, { kind: "file" })
    yield* ctx.ask({
      permission: "read",
      patterns: [path.relative(instance.worktree, canonical)],
      always: ["*"],
      metadata: { filepath: canonical },
    })
  }
  yield* ctx.ask({
    permission: "gpt_pro_consult",
    patterns: ["gpt-pro"],
    always: ["gpt-pro"],
    metadata: {
      action: "attachments",
      target,
      files: candidates.map(({ name, size }) => ({ name, size })),
      totalBytes: total,
    },
  })

  const memoryAttachments = candidates.filter((item) => item.bytes !== undefined)
  if (memoryAttachments.length) {
    log.info("private attachment staging started", { count: memoryAttachments.length })
    const temporaryDirectory = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async (signal) => {
          const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-gpt-pro-"))
          if (signal.aborted) {
            await rm(directory, { recursive: true, force: true })
            throw new Error("Interrupted")
          }
          return directory
        },
        catch: () =>
          new Error(`Unable to create private staging for GPT-Pro attachment: ${memoryAttachments[0]!.name}`),
      }).pipe(Effect.orDie),
      (directory) =>
        Effect.tryPromise({
          try: () => rm(directory, { recursive: true, force: true }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() =>
              log.error("private attachment staging cleanup failed", { count: memoryAttachments.length, error }),
            ),
          ),
          Effect.tap(() =>
            Effect.sync(() => log.info("private attachment staging cleaned", { count: memoryAttachments.length })),
          ),
          Effect.ignore,
        ),
    )
    for (const [index, item] of memoryAttachments.entries()) {
      const directory = path.join(temporaryDirectory, String(index))
      const filepath = yield* Effect.tryPromise({
        try: async (signal) => {
          if (signal.aborted) throw new Error("Interrupted")
          await mkdir(directory, { mode: 0o700 })
          const output = path.join(directory, item.name)
          await writeFile(output, item.bytes!, { flag: "wx", mode: 0o600, signal })
          return output
        },
        catch: () => new Error(`Unable to stage GPT-Pro attachment: ${item.name}`),
      }).pipe(Effect.orDie)
      item.path = filepath
      item.canonical = filepath
      item.bytes = undefined
      log.info("in-memory attachment staged", { name: item.name, size: item.size })
    }
  }

  const attachments: GptProAttachment[] = []
  for (const item of candidates) {
    log.info("attachment content inspection started", { name: item.name, size: item.size })
    const inspected = yield* Effect.tryPromise({
      try: (signal) => inspectFile(item.canonical!, item, signal),
      catch: (error) =>
        new Error(
          `GPT-Pro attachment inspection failed for ${item.name}: ${error instanceof Error ? error.message : String(error)}`,
        ),
    }).pipe(Effect.orDie)
    const mime = sniffAttachmentMime(inspected.sample, item.mime)
    const binary = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"])
    const signatureMatches =
      (mime === "application/pdf" && inspected.sample.subarray(0, 5).toString("ascii") === "%PDF-") ||
      (mime === "image/png" &&
        inspected.sample.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
      (mime === "image/jpeg" && inspected.sample.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
      (mime === "image/webp" &&
        inspected.sample.subarray(0, 4).toString("ascii") === "RIFF" &&
        inspected.sample.subarray(8, 12).toString("ascii") === "WEBP")
    if (mime !== item.mime || (binary.has(mime) && !signatureMatches)) {
      return yield* Effect.die(new Error(`Unsupported GPT-Pro attachment content: ${item.name}`))
    }
    attachments.push({
      id: randomUUID(),
      name: item.name,
      path: item.canonical!,
      mime,
      size: item.size,
      sha256: inspected.sha256,
    })
    log.info("attachment prepared", { name: item.name, size: item.size, mime })
  }
  return attachments
})

export const prepareGptProAttachments = (paths: readonly string[] | undefined, ctx: Tool.Context, target: string) =>
  prepareGptProAttachmentsImpl(paths, ctx, target).pipe(
    Effect.tapCause((cause) =>
      Effect.sync(() => log.error("GPT-Pro attachment preparation failed", { cause: Cause.pretty(cause) })),
    ),
  )
