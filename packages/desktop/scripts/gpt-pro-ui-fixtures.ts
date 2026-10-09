import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const scenarioIds = ["markdown", "text", "pdf", "unicode-filename-image", "screenshot-page"] as const
const unique = randomUUID().slice(0, 8)

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array) {
  const name = Buffer.from(type, "ascii")
  const chunk = Buffer.alloc(12 + data.byteLength)
  chunk.writeUInt32BE(data.byteLength, 0)
  name.copy(chunk, 4)
  Buffer.from(data).copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, Buffer.from(data)])), 8 + data.byteLength)
  return chunk
}

function fixturePng() {
  const width = 320
  const height = 180
  const scanlines = Buffer.alloc(height * (width * 3 + 1))
  const pixel = (x: number, y: number): [number, number, number] => {
    if (x < 14 || y < 14 || x >= width - 14 || y >= height - 14) return [34, 46, 66]
    if (x < 74 && y < 154) return [34, 190, 198]
    const dx = x - 174
    const dy = y - 90
    if (dx * dx + dy * dy < 38 * 38) return [245, 138, 71]
    if (x >= 238 && y >= 118 && (Math.floor((x - 238) / 12) + Math.floor((y - 118) / 12)) % 2 === 0)
      return [119, 137, 161]
    return [238, 242, 247]
  }
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    scanlines[row] = 0
    for (let x = 0; x < width; x++) {
      const [red, green, blue] = pixel(x, y)
      const offset = row + 1 + x * 3
      scanlines[offset] = red
      scanlines[offset + 1] = green
      scanlines[offset + 2] = blue
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function fixturePdf() {
  const text = `BT /F1 14 Tf 54 740 Td (OPENCODE_GPT_PRO_PDF_${unique}) Tj 0 -26 Td (Unique report marker for attachment verification.) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(text, "ascii")} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf, "ascii"))
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii")
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, "ascii")
}

function screenshotHtml() {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCode screenshot fixture ${unique}</title>
<style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e9eef4;color:#142438;font:600 18px/1.4 ui-sans-serif,system-ui,sans-serif}
  main{width:min(960px,92vw);padding:52px;border-radius:26px;background:white;box-shadow:0 24px 80px #14243826}
  h1{font-size:clamp(34px,7vw,76px);line-height:1.02;margin:0 0 24px;letter-spacing:-.045em}
  .marker{display:inline-block;padding:14px 20px;border-radius:12px;background:#162c4a;color:#7df1e4;font:700 clamp(16px,3vw,30px)/1.2 ui-monospace,monospace;overflow-wrap:anywhere}
  .shape{display:flex;align-items:center;gap:18px;margin-top:36px}.bar{width:24px;height:112px;border-radius:12px;background:#22bec6}.disc{width:92px;height:92px;border-radius:50%;background:#f58a47}.caption{font-size:16px;color:#52647a}
</style>
<main><h1>Screenshot<br>verification fixture</h1><div class="marker">OPENCODE_GPT_PRO_SCREENSHOT_${unique}</div><div class="shape"><span class="bar"></span><span class="disc"></span><span class="caption">Distinct bar, disc, and marker layout</span></div></main>
</html>
`
}

const tempRoot = path.join(repoRoot, ".opencode", "tmp")
await mkdir(tempRoot, { recursive: true })
const workspace = await mkdtemp(path.join(tempRoot, "gpt-pro-ui-"))
const files = {
  markdown: path.join(workspace, "fixture-notes.md"),
  text: path.join(workspace, "fixture-transcript.txt"),
  pdf: path.join(workspace, "fixture-report.pdf"),
  image: path.join(workspace, "中文 空格.png"),
  screenshot: path.join(workspace, "screenshot-fixture.html"),
}
await Promise.all([
  writeFile(
    files.markdown,
    `# Controlled Markdown Fixture\n\nMarker: OPENCODE_GPT_PRO_MD_${unique}\n\nThis document has a heading, a short list, and a unique marker.\n\n- alpha\n- beta\n`,
    { mode: 0o600 },
  ),
  writeFile(
    files.text,
    `Controlled text fixture\nMarker: OPENCODE_GPT_PRO_TEXT_${unique}\nSecond line for filename and text-content verification.\n`,
    { mode: 0o600 },
  ),
  writeFile(files.pdf, fixturePdf(), { mode: 0o600 }),
  writeFile(files.image, fixturePng(), { mode: 0o600 }),
  writeFile(files.screenshot, screenshotHtml(), { mode: 0o600 }),
])
process.stdout.write(`${JSON.stringify({ workspace, scenarioIds, files })}\n`)
