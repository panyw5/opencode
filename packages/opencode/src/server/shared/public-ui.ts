import { AppFileSystem } from "@opencode-ai/core/filesystem"

// Static UI assets the browser fetches without app-managed credentials, e.g.
// the manifest link in <head>. These bypass auth so the page can install/render
// the manifest icons even when a server password is configured.
export const PUBLIC_UI_PATHS = new Set<string>([
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

export function isPublicUIPath(method: string, pathname: string) {
  return method === "GET" && PUBLIC_UI_PATHS.has(pathname)
}

const STATIC_EXTENSIONS = new Set([
  "js",
  "mjs",
  "css",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "ico",
  "aac",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "mp4",
  "webm",
  "wasm",
])

function staticFile(file: string) {
  const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase()
  if (!STATIC_EXTENSIONS.has(extension)) return false
  const mime = AppFileSystem.mimeType(file).split(";", 1)[0].toLowerCase()
  return mime !== "text/html" && mime !== "application/xhtml+xml" && mime !== "application/json"
}

// Only the UI fallback route may use this exemption. It must never authorize
// an API route or an unknown path that would fall back to index.html.
export function isPublicEmbeddedUIAsset(method: string, pathname: string, manifest: Record<string, string> | null) {
  if (method !== "GET" || !manifest || !pathname.startsWith("/")) return false
  if (/[\\%\x00-\x1f]/.test(pathname)) return false
  const key = pathname.slice(1)
  if (key.split("/").some((part) => !part || part === "." || part === "..")) return false
  if (!Object.hasOwn(manifest, key)) return false
  const file = manifest[key]
  return typeof file === "string" && staticFile(key) && staticFile(file)
}
