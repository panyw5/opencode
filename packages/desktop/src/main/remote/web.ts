import { readFile, realpath, stat } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

export const loginPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to OpenCode</title><style>body{font:16px system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:1.5rem;color:#202020}input,button{font:inherit;padding:.7rem}button{cursor:pointer}p{line-height:1.5}</style></head><body><h1>Connect to OpenCode</h1><p>Pair this browser with your OpenCode desktop instance.</p><label>Device name <input id="name" maxlength="80" autocomplete="off"></label> <button id="connect">Connect</button><p id="status" role="status"></p><script>const code=location.hash.slice(1);history.replaceState(null,"",location.pathname);document.getElementById("connect").onclick=async()=>{const status=document.getElementById("status");status.textContent="Connecting…";try{const r=await fetch("/remote/api/pair/redeem",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code,name:document.getElementById("name").value})});if(!r.ok)throw new Error("Pairing code is invalid or expired.");location.replace("/")}catch(e){status.textContent=e.message}}</script></body></html>`

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
}

export function isPublicAsset(path: string): boolean {
  return path.startsWith("/assets/") || path === "/oc-theme-preload.js"
}

export async function serveWeb(
  request: IncomingMessage,
  response: ServerResponse,
  webRoot: string,
  path: string,
  options: { allowAppShell?: boolean; allowNavigation?: boolean } = {},
): Promise<boolean> {
  if (path === "/remote/connect" && (request.method === "GET" || request.method === "HEAD")) {
    response.statusCode = 200
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.setHeader("Cache-Control", "no-store")
    response.end(request.method === "HEAD" ? undefined : loginPage)
    return true
  }
  if (request.method !== "GET" && request.method !== "HEAD") return false
  if (path.startsWith("/remote/api/")) return false
  const asset = isPublicAsset(path)
  if (!asset && path !== "/" && !options.allowNavigation) return false
  if (path === "/" && !options.allowAppShell) return false
  const root = await realpath(webRoot).catch(() => undefined)
  if (!root) return false
  const relative = path === "/" ? "index.html" : path.slice(1)
  let file = resolve(root, relative)
  if (file !== root && !file.startsWith(root + sep)) return false
  try {
    const actual = await realpath(file)
    if (actual !== root && !actual.startsWith(root + sep)) return false
    if (!(await stat(actual)).isFile()) return false
    file = actual
  } catch {
    if (extname(path) || path === "/" || !options.allowNavigation || !request.headers.accept?.includes("text/html"))
      return false
    file = resolve(root, "index.html")
    try {
      const actual = await realpath(file)
      if (actual !== root && !actual.startsWith(root + sep)) return false
      file = actual
      if (!(await stat(file)).isFile()) return false
    } catch {
      return false
    }
  }
  response.statusCode = 200
  response.setHeader("Content-Type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream")
  response.setHeader("Cache-Control", extname(file) === ".html" ? "no-store" : "public, max-age=31536000, immutable")
  if (request.method === "HEAD") response.end()
  else response.end(await readFile(file))
  return true
}
