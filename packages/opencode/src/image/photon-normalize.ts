import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import path from "node:path"
import { fileURLToPath } from "node:url"

export type Photon = typeof import("@silvia-odwyer/photon-node")
export type Limits = { autoResize: boolean; maxWidth: number; maxHeight: number; maxBase64Bytes: number }
export type Result =
  | { type: "unchanged" }
  | {
      type: "resized"
      mime: string
      data: string
      width: number
      height: number
      originalWidth: number
      originalHeight: number
    }
  | { type: "decode-error" }
  | { type: "size-error"; bytes: number; width: number; height: number }

export async function load(): Promise<Photon> {
  ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
    path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
  return import("@silvia-odwyer/photon-node")
}

export function normalize(photon: Photon, base64: string, info: Limits): Result {
  let decoded: InstanceType<Photon["PhotonImage"]>
  try {
    decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"))
  } catch {
    return { type: "decode-error" }
  }
  try {
    const width = decoded.get_width()
    const height = decoded.get_height()
    const bytes = base64.length
    const tooLarge: Result = { type: "size-error", bytes, width, height }
    if (width <= info.maxWidth && height <= info.maxHeight && bytes <= info.maxBase64Bytes) return { type: "unchanged" }
    if (!info.autoResize) return tooLarge
    const scale = Math.min(1, info.maxWidth / width, info.maxHeight / height)
    let size = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
    for (let attempt = 0; attempt < 32; attempt++) {
      const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
      try {
        // Encode candidates lazily: a fitting PNG avoids five redundant JPEG encodes.
        for (const quality of [undefined, 80, 85, 70, 55, 40]) {
          const candidate = quality === undefined ? resized.get_bytes() : resized.get_bytes_jpeg(quality)
          if (Math.ceil(candidate.length / 3) * 4 <= info.maxBase64Bytes) {
            return {
              type: "resized",
              mime: quality === undefined ? "image/png" : "image/jpeg",
              data: Buffer.from(candidate).toString("base64"),
              ...size,
              originalWidth: width,
              originalHeight: height,
            }
          }
        }
      } finally {
        resized.free()
      }
      const next = {
        width: Math.max(1, Math.floor(size.width * 0.75)),
        height: Math.max(1, Math.floor(size.height * 0.75)),
      }
      if (next.width === size.width && next.height === size.height) break
      size = next
    }
    return tooLarge
  } finally {
    decoded.free()
  }
}
