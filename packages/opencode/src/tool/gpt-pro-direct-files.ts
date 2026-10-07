import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.gpt_pro_direct_files" })
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_FILE_BYTES / 3)
const EXTENSION_BY_MIME: Record<string, string> = {
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
}

export type GptProDirectFiles = {
  files: string[]
  cleanup: () => Effect.Effect<void>
}

function baseName(value: string | undefined, fallback: string) {
  const normalized = (value ?? "").replaceAll("\\", "/")
  const name = path.posix.basename(normalized).replaceAll("\0", "").trim()
  return name && name !== "." && name !== ".." ? name : fallback
}

/** Materialize only explicitly attached user parts; remote URLs are never fetched. */
export function materializeGptProDirectFiles(parts: readonly unknown[], directory: string) {
  return Effect.tryPromise<GptProDirectFiles, Error>({
    try: async (signal) => {
      const files: string[] = []
      let temporaryDirectory: string | undefined
      let totalBytes = 0
      try {
        for (const raw of parts) {
          if (signal.aborted) throw new Error("GPT-Pro attachment preparation was interrupted")
          const part = raw as {
            type?: string
            filename?: string
            url?: string
            source?: { type?: string; path?: string }
          }
          if (part.type !== "file") continue
          if (files.length >= 10) throw new Error("@gpt-pro accepts at most 10 attachments")
          if (part.source?.type === "file" && part.source.path) {
            files.push(part.source.path)
            continue
          }
          if (part.url?.startsWith("file:")) {
            try {
              files.push(fileURLToPath(part.url))
            } catch {
              throw new Error("The @gpt-pro file URL is invalid")
            }
            continue
          }
          const data = /^data:([^;,]+);base64,([\s\S]*)$/.exec(part.url ?? "")
          if (!data) throw new Error("@gpt-pro only accepts local files or pasted data attachments")
          const mime = data[1]!
          const extension = EXTENSION_BY_MIME[mime]
          const encoded = data[2]!
          if (
            !extension ||
            encoded.length > MAX_BASE64_CHARS ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
          ) {
            throw new Error(`Unsupported or malformed @gpt-pro pasted attachment: ${mime}`)
          }
          const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
          const decodedLength = (encoded.length * 3) / 4 - padding
          if (decodedLength > MAX_FILE_BYTES || totalBytes + decodedLength > MAX_TOTAL_BYTES) {
            throw new Error("@gpt-pro pasted attachments exceed the 20 MB per-file or 50 MB total limit")
          }
          totalBytes += decodedLength
          const bytes = Buffer.from(encoded, "base64")
          if (bytes.byteLength !== decodedLength || bytes.toString("base64") !== encoded) {
            throw new Error(`Malformed @gpt-pro pasted attachment: ${mime}`)
          }

          temporaryDirectory ??= await (async () => {
            const root = await realpath(directory)
            const stagingRoot = path.join(root, ".opencode")
            let rootInfo: Awaited<ReturnType<typeof lstat>> | undefined
            try {
              rootInfo = await lstat(stagingRoot)
            } catch (error) {
              if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
            }
            if (rootInfo?.isSymbolicLink())
              throw new Error("Refusing to stage GPT-Pro files through a .opencode symlink")
            if (!rootInfo) await mkdir(stagingRoot, { mode: 0o700 })
            const resolvedStagingRoot = await realpath(stagingRoot)
            const relative = path.relative(root, resolvedStagingRoot)
            if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
              throw new Error("Refusing to stage GPT-Pro files outside the workspace")
            }
            if (signal.aborted) throw new Error("GPT-Pro attachment preparation was interrupted")
            return mkdtemp(path.join(resolvedStagingRoot, "gpt-pro-"))
          })()
          if (signal.aborted) throw new Error("GPT-Pro attachment preparation was interrupted")
          const index = files.length
          const attachmentDirectory = path.join(temporaryDirectory, String(index))
          await mkdir(attachmentDirectory, { mode: 0o700 })
          const name = baseName(part.filename, `pasted-${index}${extension}`)
          const extensionFromName = path.extname(name)
          const allowedExtensions =
            mime === "text/markdown"
              ? [".md"]
              : mime === "text/plain"
                ? [".txt"]
                : mime === "image/jpeg"
                  ? [".jpg", ".jpeg"]
                  : [extension]
          if (extensionFromName && !allowedExtensions.includes(extensionFromName.toLowerCase())) {
            throw new Error(`The @gpt-pro filename extension does not match ${mime}`)
          }
          const finalName = extensionFromName ? name : `${name}${extension}`
          if (Buffer.byteLength(finalName, "utf8") > 240) throw new Error("The @gpt-pro filename is too long")
          const temporaryPath = path.join(attachmentDirectory, finalName)
          // Explicit private modes are required for pasted user data before the desktop stages it.
          await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600, signal })
          if (signal.aborted) throw new Error("GPT-Pro attachment preparation was interrupted")
          files.push(temporaryPath)
          log.info("pasted attachment materialized", { name: finalName, size: bytes.byteLength, mime })
        }
      } catch (error) {
        if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
        throw error instanceof Error ? error : new Error(String(error))
      }
      const cleanup = () =>
        temporaryDirectory
          ? Effect.tryPromise({
              try: () => rm(temporaryDirectory!, { recursive: true, force: true }),
              catch: () => undefined,
            }).pipe(Effect.ignore)
          : Effect.void
      return { files, cleanup }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.tapError((error) => Effect.sync(() => log.error("direct GPT-Pro attachment preparation failed", { error }))),
  )
}
