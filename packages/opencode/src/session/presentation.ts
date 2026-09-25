import { createHash, randomUUID } from "node:crypto"
import { access, mkdir, readFile, rename, realpath, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import * as Log from "@opencode-ai/core/util/log"
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { fileURLToPath } from "node:url"

const log = Log.create({ service: "session.presentation" })
// Keep the fallback thumbnail bounded even when an optional image codec is unavailable.
const MAX_BYTES = 8 * 1024 * 1024
const MAX_SVG_BYTES = 5 * 1024 * 1024
const ROOT = () => path.join(Global.Path.data, "presentation")
const THUMBNAIL_MAX = 500 * 1024

export type PresentationPurpose = "result" | "verification" | "diagram"
export type PresentationArtifact = {
  artifactID: string
  mime: string
  width?: number
  height?: number
  filename: string
  size: number
  sourcePath: string
  purpose: PresentationPurpose
  caption?: string
}

type Detected = { mime: string; extension: string; width?: number; height?: number }

async function makeThumbnail(data: Uint8Array, originalMime: string): Promise<{ body: Uint8Array; mime: string } | undefined> {
  try {
    ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
      path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
    const photon = await import("@silvia-odwyer/photon-node")
    const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(data))
    try {
      const width = decoded.get_width()
      const height = decoded.get_height()
      const scale = Math.min(1, 960 / width, 960 / height)
      if (scale === 1 && data.length <= THUMBNAIL_MAX) return { body: data, mime: originalMime }
      let targetWidth = Math.max(1, Math.round(width * scale))
      let targetHeight = Math.max(1, Math.round(height * scale))
      for (let attempt = 0; attempt < 6; attempt++) {
        const resized = photon.resize(decoded, targetWidth, targetHeight, photon.SamplingFilter.Lanczos3)
        try {
          for (const quality of [75, 55, 40]) {
            const jpeg = Buffer.from(resized.get_bytes_jpeg(quality))
            if (jpeg.length <= THUMBNAIL_MAX) return { body: new Uint8Array(jpeg), mime: "image/jpeg" }
          }
          const png = Buffer.from(resized.get_bytes())
          if (png.length <= THUMBNAIL_MAX) return { body: new Uint8Array(png), mime: "image/png" }
        } finally {
          resized.free()
        }
        targetWidth = Math.max(1, Math.floor(targetWidth * 0.75))
        targetHeight = Math.max(1, Math.floor(targetHeight * 0.75))
      }
      return undefined
    } finally {
      decoded.free()
    }
  } catch (error) {
    log.warn("thumbnail generation unavailable; serving original", { error })
    return undefined
  }
}

function dimensions(data: Uint8Array, mime: string): { width?: number; height?: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (mime === "image/png" && data.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (mime === "image/gif" && data.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  // JPEG/WebP marker parsing is intentionally omitted until a full segment-aware
  // parser is available; incorrect geometry is worse than leaving it unknown.
  if (mime === "image/svg+xml") {
    const text = new TextDecoder().decode(data).slice(0, 64 * 1024)
    const viewBox = text.match(/viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i)
    const width = text.match(/\bwidth\s*=\s*["']([\d.]+)/i)
    const height = text.match(/\bheight\s*=\s*["']([\d.]+)/i)
    return { width: viewBox ? Number(viewBox[1]) : width ? Number(width[1]) : undefined, height: viewBox ? Number(viewBox[2]) : height ? Number(height[1]) : undefined }
  }
  return {}
}

function detect(data: Uint8Array, source: string): Detected {
  const ext = path.extname(source).toLowerCase()
  const text = () => new TextDecoder().decode(data.slice(0, 1024)).trimStart()
  if (data.length >= 8 && data.slice(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i])) return { mime: "image/png", extension: ".png", ...dimensions(data, "image/png") }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mime: "image/jpeg", extension: ".jpg", ...dimensions(data, "image/jpeg") }
  if (text().startsWith("GIF8")) return { mime: "image/gif", extension: ".gif", ...dimensions(data, "image/gif") }
  if (data.length >= 12 && new TextDecoder().decode(data.slice(0, 4)) === "RIFF" && new TextDecoder().decode(data.slice(8, 12)) === "WEBP") return { mime: "image/webp", extension: ".webp", ...dimensions(data, "image/webp") }
  if (ext === ".svg" || /<svg[\s>]/i.test(text())) {
    if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[^]*?-->\s*)*<svg(?:\s|>)/i.test(new TextDecoder().decode(data))) throw new Error("SVG must contain an SVG root element")
    return { mime: "image/svg+xml", extension: ".svg", ...dimensions(data, "image/svg+xml") }
  }
  throw new Error("present_file only supports PNG, JPEG, GIF, WebP, and SVG images")
}

function safeSvg(data: Uint8Array) {
  const text = new TextDecoder().decode(data)
  if (/<script\b|\bon[a-z]+\s*=|javascript:|<foreignObject\b|<iframe\b|<object\b|<embed\b/i.test(text)) throw new Error("SVG contains executable, external, or unsafe content")
  for (const match of text.matchAll(/(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi)) {
    if (!match[1]?.startsWith("#")) throw new Error("SVG contains external or unsafe references")
  }
  if (/@import\b|url\s*\(\s*["']?(?!#)(?:https?:|data:|file:|\/|\.\.?\/)/i.test(text) || /<!ENTITY\b|<!DOCTYPE\b/i.test(text)) throw new Error("SVG contains external CSS or entity declarations")
}

export function validateSvgSource(source: string) {
  const data = new TextEncoder().encode(source)
  detect(data, "diagram.svg")
  safeSvg(data)
}

function dir(sessionID: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) throw new Error("Invalid session ID")
  return path.join(ROOT(), sessionID)
}

export async function snapshot(input: { sessionID: string; sourcePath: string; purpose: PresentationPurpose; caption?: string }): Promise<PresentationArtifact> {
  const sourcePath = await realpath(input.sourcePath)
  const source = await stat(sourcePath)
  if (!source.isFile()) throw new Error("present_file source is not a regular file")
  if (source.size > MAX_BYTES) throw new Error(`present_file source exceeds ${MAX_BYTES} bytes`)
  await access(sourcePath)
  const data = new Uint8Array(await readFile(sourcePath))
  if (data.length > MAX_BYTES) throw new Error(`present_file source exceeds ${MAX_BYTES} bytes`)
  const detected = detect(data, sourcePath)
  if (detected.mime === "image/svg+xml") {
    if (data.length > MAX_SVG_BYTES) throw new Error("SVG exceeds the safe size limit")
    safeSvg(data)
  }
  const digest = createHash("sha256").update(data).digest("hex").slice(0, 32)
  const artifactID = `pa_${digest}`
  const storageFilename = `${artifactID}${detected.extension}`
  const filename = path.basename(sourcePath)
  const targetDir = dir(input.sessionID)
  const target = path.join(targetDir, storageFilename)
  await mkdir(targetDir, { recursive: true })
  try {
    await access(target)
  } catch {
    const temp = path.join(targetDir, `.${storageFilename}.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, data, { flag: "wx" })
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
  if (detected.mime !== "image/svg+xml") {
    const thumbnail = await makeThumbnail(data, detected.mime)
    if (thumbnail) await writeFile(path.join(targetDir, `${artifactID}.thumb${thumbnail.mime === "image/jpeg" ? ".jpg" : thumbnail.mime === "image/png" ? ".png" : detected.extension}`), thumbnail.body)
  }
  log.info("presentation snapshot created", { sessionID: input.sessionID, artifactID, sourcePath, bytes: data.length })
  return { artifactID, mime: detected.mime, width: detected.width, height: detected.height, filename, size: data.length, sourcePath, purpose: input.purpose, ...(input.caption ? { caption: input.caption } : {}) }
}

export async function readArtifact(input: { sessionID: string; artifactID: string; variant?: string }) {
  if (!/^pa_[a-f0-9]{32}$/.test(input.artifactID)) return undefined
  if (input.variant && input.variant !== "original" && input.variant !== "thumbnail") return undefined
  const root = dir(input.sessionID)
  const entries = await (await import("node:fs/promises")).readdir(root).catch(() => [] as string[])
  const filename = input.variant === "thumbnail"
    ? entries.find((name) => name.startsWith(`${input.artifactID}.thumb.`)) ?? entries.find((name) => name.startsWith(`${input.artifactID}.`))
    : entries.find((name) => name.startsWith(`${input.artifactID}.`) && !name.includes(".thumb."))
  if (!filename) return undefined
  const file = path.join(root, filename)
  const body = await readFile(file)
  const ext = path.extname(filename).toLowerCase()
  const mime = ext === ".png" ? "image/png" : ext === ".jpg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/svg+xml"
  return { body: new Uint8Array(body), mime }
}

/** Remove immutable presentation snapshots when a session is permanently deleted. */
export async function removeSessionArtifacts(sessionID: string) {
  await rm(dir(sessionID), { recursive: true, force: true })
  log.info("presentation snapshots removed", { sessionID })
}
