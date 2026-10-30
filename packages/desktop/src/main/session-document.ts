import { BrowserWindow, dialog, session, nativeImage } from "electron"
import { mkdtemp, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { documentName, isolatedHTML, pngSlices, validateDocument } from "./session-document-policy"
import { write as log } from "./logging"
import {
  captureRect,
  exportErrorName,
  exportWorld,
  heightScript,
  readyScript,
  scrollScript,
} from "./session-document-render"

let exporting = false

export async function exportSessionDocument(parent: BrowserWindow, value: unknown) {
  if (exporting) throw new Error("Another document export is in progress")
  log("session-export", `policy=payload-v2 pid=${process.pid} main=${import.meta.url} budgets markdown=8388608 html=33554432; validating`)
  const input = validateDocument(value)
  log("session-export", `policy=payload-v2 format=${input.format} bytes=${Buffer.byteLength(input.format === "markdown" ? input.markdown! : input.html!)}`)
  exporting = true
  let window: BrowserWindow | undefined
  const partition = session.fromPartition(`session-export-${randomUUID()}`, { cache: false })
  let currentStage = "initializing"
  const stage = (message: string) => {
    currentStage = message
    log("session-export", `${input.format}: ${message}`)
  }
  try {
    stage("validated; opening save dialog")
    const extension = input.format === "markdown" ? "md" : input.format
    const result = await dialog.showSaveDialog(parent, {
      title: input.format === "png" ? "Export PNG (long documents use a new numbered-parts folder)" : "Export session",
      defaultPath: `${documentName(input.name)}.${extension}`,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    })
    if (result.canceled || !result.filePath) {
      stage("cancelled")
      return { cancelled: true, files: 0 }
    }
    if (input.format === "markdown") {
      stage("writing UTF-8 document")
      await writeFile(result.filePath, input.markdown!, "utf8")
      stage("complete files=1")
      return { cancelled: false, files: 1 }
    }
    stage("creating isolated renderer")
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    partition.setPermissionCheckHandler(() => false)
    partition.on("will-download", (event) => event.preventDefault())
    partition.webRequest.onBeforeRequest((details, callback) => {
      const allowed =
        details.resourceType === "mainFrame"
          ? details.url === "https://session-export.invalid/document"
          : /^data:(image\/(png|jpeg|gif|webp|avif)|font\/[a-z0-9-]+)[;,]/i.test(details.url)
      callback({ cancel: !allowed })
    })
    // Avoid Chromium's data-URL size ceiling when embedding real app fonts.
    // The private session serves exactly one inert in-memory document.
    partition.protocol.handle("https", (request) => {
      if (request.url !== "https://session-export.invalid/document") return new Response(null, { status: 403 })
      return new Response(isolatedHTML(input.html!, input.theme), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    })
    window = new BrowserWindow({
      show: false,
      width: input.width ?? 1200,
      height: 4096,
      useContentSize: true,
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Required for trusted isolated-world scheduling; CSP still denies all page scripts.
        javascript: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
      },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.webContents.on("will-navigate", (event) => event.preventDefault())
    window.webContents.on("will-redirect", (event) => event.preventDefault())
    const execute = (code: string) => window!.webContents.executeJavaScriptInIsolatedWorld(exportWorld, [{ code }])
    stage("loading isolated document")
    await window.loadURL("https://session-export.invalid/document")
    stage("waiting for fonts and images")
    await execute(readyScript)
    stage(
      `layout ${JSON.stringify(await execute(`(()=>{const e=document.querySelector('[data-export-style]');const s=e&&getComputedStyle(e);return {x:e?.getBoundingClientRect().x,y:e?.getBoundingClientRect().y,visibility:s?.visibility,display:s?.display,opacity:s?.opacity}})()`))}`,
    )
    stage("measuring document height")
    const height = Math.ceil((await execute(heightScript)) as number)
    const slices = pngSlices(height)
    stage(`render ready; height=${Math.ceil(height)} parts=${slices.length}`)
    if (input.format === "pdf") {
      stage("printing PDF")
      const pdf = await window.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        pageSize: { width: ((input.width ?? 1200) * 25400) / 96, height: 297000 },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      })
      stage("writing PDF")
      await writeFile(result.filePath, pdf)
      stage("complete files=1")
      return { cancelled: false, files: 1 }
    }
    // Bound each assembled bitmap to 64 MiB (4 bytes/pixel). Capture tiles
    // remain 4096 CSS px; unusually tall exports get numbered output parts.
    const width = input.width ?? 1200
    const partHeight = Math.max(4096, Math.min(16000, Math.floor((64 * 1024 * 1024) / (width * 4))))
    const parts = Array.from({ length: Math.ceil(height / partHeight) }, (_, index) => ({
      y: index * partHeight,
      height: Math.min(partHeight, height - index * partHeight),
    }))
    const folder =
      parts.length > 1
        ? await mkdtemp(join(dirname(result.filePath), `${documentName(input.name)}-png-parts-`))
        : undefined
    for (const [index, part] of parts.entries()) {
      const bitmap = Buffer.alloc(width * part.height * 4)
      for (let offset = 0; offset < part.height; offset += 4096) {
        const slice = { y: part.y + offset, height: Math.min(4096, part.height - offset) }
        stage(`positioning part=${index + 1}/${parts.length} tile=${offset / 4096 + 1}`)
        const scrollY = (await execute(scrollScript(slice.y))) as number
        stage(`capturing part=${index + 1}/${parts.length}`)
        const image = await window.webContents.capturePage(captureRect(slice, scrollY, width), {
          stayHidden: true,
          stayAwake: true,
        })
        // Normalize Retina captures to CSS pixels before copying tightly packed BGRA rows.
        const tile = image.resize({ width, height: slice.height }).toBitmap({ scaleFactor: 1 })
        if (tile.length !== width * slice.height * 4) throw new Error("Unexpected export bitmap size")
        tile.copy(bitmap, offset * width * 4)
      }
      stage(`writing part=${index + 1}/${parts.length}`)
      await writeFile(
        folder ? join(folder, `part-${String(index + 1).padStart(3, "0")}.png`) : result.filePath,
        nativeImage.createFromBitmap(bitmap, { width, height: part.height, scaleFactor: 1 }).toPNG(),
      )
    }
    stage(`complete files=${parts.length}`)
    return { cancelled: false, files: parts.length }
  } catch (error) {
    log("session-export", `${input.format}: failed stage=${currentStage} error=${exportErrorName(error)}`)
    throw error
  } finally {
    if (window && !window.isDestroyed()) window.destroy()
    partition.webRequest.onBeforeRequest(null)
    partition.protocol.unhandle("https")
    await partition.clearStorageData().catch(() => {})
    exporting = false
    stage("isolated renderer cleaned up")
  }
}
