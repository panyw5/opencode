// Isolated regression app. Never connects to, closes, or changes the user's app.
// Bundle with bun build --target=node --external=electron, then run with Electron.
import { app, BrowserWindow, dialog, nativeImage } from "electron"
import { readFile, stat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { exportSessionDocument } from "../src/main/session-document"
import { initLogging } from "../src/main/logging"

const folder = process.env.SESSION_EXPORT_TEST_DIR
if (!folder) throw new Error("SESSION_EXPORT_TEST_DIR is required")
app.setPath("userData", join(folder, "profile"))
void app.whenReady().then(async () => {
  console.log("[fidelity-test] isolated Electron ready")
  initLogging()
  const parent = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  let destination = ""
  dialog.showSaveDialog = (async () => ({ canceled: false, filePath: destination })) as typeof dialog.showSaveDialog
  try {
    const html = await readFile(join(folder, "snapshot.html"), "utf8")
    for (const format of ["png", "pdf"] as const) {
      destination = join(folder, `fidelity.${format}`)
      const result = await exportSessionDocument(parent, { format, name: "fixture", html, width: 600, theme: "light" })
      if (result.cancelled || result.files < 1) throw new Error("Unexpected export result")
      if (format === "png" && result.files > 1) {
        const folders = (await readdir(folder)).filter(name => name.startsWith("fixture-png-parts-"));
        const output = join(folder, folders[folders.length - 1]);
        const files = (await readdir(output)).filter(name => name.endsWith('.png')).sort();
        if (files.length !== result.files) throw new Error('Missing PNG parts');
        let height = 0;
        for (const file of files) {
          const image = nativeImage.createFromPath(join(output, file));
          const size = image.getSize();
          if (size.width !== 600 || size.height < 1 || size.height > 16000) throw new Error('Invalid PNG part');
          height += size.height;
          console.log(`[fidelity-test] PNG ${file} ${size.width}x${size.height} bytes=${(await stat(join(output,file))).size}`);
        }
        const image = nativeImage.createFromPath(join(output, files[files.length - 1]));
        const pixel = ((image.getSize().height - 40) * 600 + 40) * 4;
        const bitmap = image.toBitmap({scaleFactor:1});
        if (bitmap[pixel+1] < 180 || bitmap[pixel+1] < bitmap[pixel+2]+80) throw new Error('Lost final tile');
        console.log(`[fidelity-test] PNG total height=${height}; final tile verified; folder=${output}`);
        continue;
      }
      if ((await stat(destination)).size < 1000) throw new Error("Empty export")
      if (format === "png") {
        const image = nativeImage.createFromPath(destination)
        const size = image.getSize()
         if (size.width !== 600 || size.height < 5000 || size.height > 30000)
          throw new Error(`Invalid image size ${JSON.stringify(size)}`)
        // Long fixture's last rows are saturated green; ensure stitching retained them.
        const bitmap = image.toBitmap({ scaleFactor: 1 })
        console.log(
          `[fidelity-test] pixels ${[100, 4000, 5000, size.height - 40].map((y) => Array.from(bitmap.subarray((y * size.width + 40) * 4, (y * size.width + 40) * 4 + 4)).join(",")).join(";")}`,
        )
        const pixel = ((size.height - 40) * size.width + 40) * 4
        if (bitmap[pixel + 1] < 180 || bitmap[pixel + 1] < bitmap[pixel + 2] + 80) throw new Error("Lost final tile")
        console.log(`[fidelity-test] PNG ${size.width}x${size.height}; final tile verified`)
      } else {
        const data = await readFile(destination)
        if (!data.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Invalid PDF")
        console.log(`[fidelity-test] PDF bytes=${data.length}`)
      }
    }
  } catch (error) {
    console.error(`[fidelity-test] failed ${String(error)}`)
    process.exitCode = 1
  } finally {
    parent.destroy()
    app.quit()
  }
})
