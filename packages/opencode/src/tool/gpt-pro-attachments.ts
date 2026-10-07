import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { realpath, stat, open } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { GptProAttachment } from "@opencode-ai/util/gpt-pro"
import { InstanceState } from "@/effect/instance-state"
import { sniffAttachmentMime } from "@/util/media"
import type * as Tool from "./tool"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.gpt_pro_attachments" })
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const SAMPLE_BYTES = 4096
const ALLOWED_MIME = new Set([
  "text/markdown",
  "text/plain",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
])
const EXTENSION_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
}

type Candidate = { path: string; name: string; canonical: string; size: number; dev: number; ino: number }

// A file descriptor is required here to reject final-component symlinks and
// compare the authorized inode before reading bytes, then verify it stayed stable.
async function digestFile(filepath: string, expected: Candidate) {
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
      Number(opened.dev) !== expected.dev ||
      Number(opened.ino) !== expected.ino
    ) {
      throw new Error("Attachment changed after authorization")
    }
    const expectedMime = EXTENSION_MIME[path.extname(expected.canonical).toLowerCase()]
    const textDecoder = expectedMime.startsWith("text/") ? new TextDecoder("utf-8", { fatal: true }) : undefined
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > MAX_FILE_BYTES) throw new Error("Attachment exceeds 20 MB during read")
      if (textDecoder) {
        if (chunk.includes(0)) throw new Error("Text attachments cannot contain NUL bytes")
        textDecoder.decode(chunk, { stream: true })
      }
      if (sample.length < SAMPLE_BYTES)
        sample = Buffer.concat([sample, chunk.subarray(0, SAMPLE_BYTES - sample.length)])
      hash.update(chunk)
    }
    textDecoder?.decode()
    if (bytes !== opened.size) throw new Error("Attachment changed while being read")
    const after = await handle.stat()
    if (
      Number(after.dev) !== expected.dev ||
      Number(after.ino) !== expected.ino ||
      after.size !== expected.size ||
      after.size !== opened.size
    ) {
      throw new Error("Attachment changed while being read")
    }
    return { sha256: hash.digest("hex"), sample, opened: after }
  } finally {
    await handle.close()
  }
}

/** Validate and authorize local files before computing any content hashes. */
export const prepareGptProAttachments = Effect.fn("GptProAttachments.prepare")(function* (
  paths: readonly string[] | undefined,
  ctx: Tool.Context,
  target: string,
) {
  if (!paths?.length) return [] as GptProAttachment[]
  if (paths.length > 10) return yield* Effect.die(new Error("GPT-Pro accepts at most 10 attachments"))

  const instance = yield* InstanceState.context
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const input of paths) {
    if (!input || input.length > 4096 || input.includes("\0")) {
      return yield* Effect.die(new Error("Invalid GPT-Pro attachment path"))
    }
    const absolute = path.isAbsolute(input) ? input : path.resolve(instance.directory, input)
    const canonical = yield* Effect.tryPromise({
      try: () => realpath(absolute),
      catch: () => new Error(`GPT-Pro attachment not found: ${input}`),
    }).pipe(Effect.orDie)
    if (seen.has(canonical)) {
      log.info("duplicate attachment path skipped", { name: path.basename(canonical) })
      continue
    }
    seen.add(canonical)
    const info = yield* Effect.tryPromise({
      try: () => stat(canonical),
      catch: () => new Error(`Unable to inspect GPT-Pro attachment: ${input}`),
    }).pipe(Effect.orDie)
    if (!info.isFile()) return yield* Effect.die(new Error(`GPT-Pro attachment must be a regular file: ${input}`))
    if (info.size > MAX_FILE_BYTES)
      return yield* Effect.die(new Error(`GPT-Pro attachment exceeds 20 MB: ${path.basename(canonical)}`))
    const extension = path.extname(canonical).toLowerCase()
    if (!EXTENSION_MIME[extension]) {
      return yield* Effect.die(new Error(`Unsupported GPT-Pro attachment type: ${path.basename(canonical)}`))
    }
    candidates.push({
      path: input,
      canonical,
      name: path.basename(canonical),
      size: info.size,
      dev: Number(info.dev),
      ino: Number(info.ino),
    })
  }

  const totalBytes = candidates.reduce((total, item) => total + item.size, 0)
  if (totalBytes > MAX_TOTAL_BYTES) return yield* Effect.die(new Error("GPT-Pro attachments exceed 50 MB total"))

  log.info("attachment authorization started", { count: candidates.length, totalBytes, target })
  for (const item of candidates) {
    yield* assertExternalDirectoryEffect(ctx, item.canonical, { kind: "file" })
    yield* ctx.ask({
      permission: "read",
      patterns: [path.relative(instance.worktree, item.canonical)],
      always: ["*"],
      metadata: { filepath: item.canonical },
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
      totalBytes,
    },
  })

  const attachments: GptProAttachment[] = []
  for (const item of candidates) {
    log.info("attachment content inspection started", { name: item.name, size: item.size })
    const { sha256, sample, opened } = yield* Effect.tryPromise({
      try: () => digestFile(item.canonical, item),
      catch: () => new Error(`Unable to read GPT-Pro attachment: ${item.name}`),
    }).pipe(Effect.orDie)
    if (Number(opened.dev) !== item.dev || Number(opened.ino) !== item.ino || opened.size !== item.size) {
      return yield* Effect.die(new Error(`GPT-Pro attachment changed after authorization: ${item.name}`))
    }
    const expectedMime = EXTENSION_MIME[path.extname(item.canonical).toLowerCase()]
    const mime = sniffAttachmentMime(sample, expectedMime)
    const binary = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"])
    const signatureMatches =
      (mime === "application/pdf" && sample.subarray(0, 5).toString("ascii") === "%PDF-") ||
      (mime === "image/png" &&
        sample.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
      (mime === "image/jpeg" && sample.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
      (mime === "image/webp" &&
        sample.subarray(0, 4).toString("ascii") === "RIFF" &&
        sample.subarray(8, 12).toString("ascii") === "WEBP")
    if (!ALLOWED_MIME.has(mime) || mime !== expectedMime || (binary.has(mime) && !signatureMatches)) {
      return yield* Effect.die(new Error(`Unsupported GPT-Pro attachment content: ${item.name}`))
    }
    const attachment = {
      id: randomUUID(),
      name: item.name,
      path: item.canonical,
      mime,
      size: item.size,
      sha256,
    }
    attachments.push(attachment)
    log.info("attachment prepared", { id: attachment.id, name: attachment.name, size: attachment.size, mime })
  }
  return attachments
})
