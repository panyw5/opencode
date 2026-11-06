// Bundle with bun build --target=node --external=electron, then run with Electron.
// Uses an isolated profile and never closes the user's installed or dev app.
import { app, BrowserWindow, dialog, nativeImage } from "electron"
import { strict as assert } from "node:assert"
import { mkdtemp, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { exportSessionDocument } from "../src/main/session-document"
import { initLogging } from "../src/main/logging"
import { shareImageLayouts } from "../../app/src/components/session/session-share-layout"

const folder = process.env.SESSION_EXPORT_TEST_DIR
if (!folder)
  throw new Error("SESSION_EXPORT_TEST_DIR is required; generate snapshots with test-session-share-layout.ts")
app.setPath("userData", join(folder, "profile"))
void app.whenReady().then(async () => {
  initLogging()
  const parent = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  let destination = ""
  dialog.showSaveDialog = (async () => ({ canceled: false, filePath: destination })) as typeof dialog.showSaveDialog
  try {
    const run = await mkdtemp(join(folder, "render-"))
    for (const layout of shareImageLayouts) {
      const html = await readFile(join(folder, `${layout.id}.html`), "utf8")
      destination = join(run, `${layout.id}.png`)
      const result = await exportSessionDocument(parent, {
        format: "png",
        name: layout.id,
        width: layout.width,
        theme: "light",
        html: html + '<div style="height:17000px;background:rgb(0,220,0)"></div>',
      })
      assert.equal(result.cancelled, false)
      assert.ok(result.files > 1, "Long document must split into bounded parts")
      const directories = (await readdir(run)).filter((name) => name.startsWith(`${layout.id}-png-parts-`))
      assert.equal(directories.length, 1)
      const output = join(run, directories[0])
      const files = (await readdir(output)).filter((name) => name.endsWith(".png")).sort()
      assert.equal(files.length, result.files)
      let height = 0
      for (const file of files) {
        const image = nativeImage.createFromPath(join(output, file))
        const size = image.getSize()
        assert.equal(size.width, layout.width)
        assert.ok(size.height > 0 && size.height <= 16000)
        height += size.height
      }
      const image = nativeImage.createFromPath(join(output, files[files.length - 1]))
      const pixel = ((image.getSize().height - 40) * layout.width + 40) * 4
      const bitmap = image.toBitmap({ scaleFactor: 1 })
      console.log(`[share-layout-export] tail BGRA=${Array.from(bitmap.subarray(pixel, pixel + 4)).join(",")}`)
      assert.ok(bitmap[pixel + 1] > 180 && bitmap[pixel + 1] > bitmap[pixel + 2] + 80, "Final tile retained")
      console.log(
        `[share-layout-export] layout=${layout.id} width=${layout.width} height=${height} parts=${files.length} final-tile=ok`,
      )
    }
    console.log(`[share-layout-export] output=${run}`)
  } catch (error) {
    console.error(`[share-layout-export] failed ${String(error)}`)
    process.exitCode = 1
  } finally {
    parent.destroy()
    app.exit(process.exitCode ?? 0)
  }
})
