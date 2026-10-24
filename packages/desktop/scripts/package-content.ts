import { open, readdir, stat } from "node:fs/promises"
import path from "node:path"

type Entry = { size?: number; offset?: string; unpacked?: boolean; files?: Record<string, Entry> }
export type PackageEntry = { path: string; size: number; offset?: string; unpacked?: boolean }

export async function readAsar(file: string) {
  const handle = await open(file, "r")
  try {
    const prefix = Buffer.alloc(16)
    await handle.read(prefix, 0, prefix.length, 0)
    const length = prefix.readUInt32LE(12)
    if (length > 32 * 1024 * 1024) throw new Error("Unexpected ASAR header size")
    const header = Buffer.alloc(length)
    await handle.read(header, 0, length, 16)
    const entries: PackageEntry[] = []
    function walk(entry: Entry, parent = "") {
      for (const [name, child] of Object.entries(entry.files ?? {})) {
        const file = parent ? `${parent}/${name}` : name
        if (child.files) walk(child, file)
        else entries.push({ path: file, size: child.size ?? 0, offset: child.offset, unpacked: child.unpacked })
      }
    }
    walk(JSON.parse(header.toString()))
    return { entries, dataOffset: 8 + prefix.readUInt32LE(4) }
  } finally {
    await handle.close()
  }
}

export function assertPackageEntries(entries: PackageEntry[]) {
  const paths = new Set(entries.map((entry) => entry.path))
  for (const required of [
    "out/main/index.js",
    "out/main/sidecar.js",
    "out/main/remote-worker.js",
    "out/preload/index.js",
  ]) {
    if (!paths.has(required)) throw new Error(`Missing packaged entry: ${required}`)
  }
  const unwanted = entries.find(
    ({ path }) =>
      /^node_modules\/@opencode-ai\/(core|util|remote-tunnel)\/(src|test|tests|scripts)\//.test(path) ||
      path.startsWith("node_modules/@opencode-ai/remote-tunnel/node_modules/") ||
      /^node_modules\/@opentunnel\/(client|protocol)\/(src|dist)\//.test(path) ||
      /^node_modules\/effect\/(src|ai-docs)\//.test(path),
  )
  if (unwanted) throw new Error(`Redundant packaged dependency/source: ${unwanted.path}`)
  if (!paths.has("node_modules/effect/dist/Effect.js")) throw new Error("Effect runtime must remain available")
  if (!entries.some(({ path }) => path.startsWith("node_modules/effect/") && /license/i.test(path)))
    throw new Error("Effect license must remain in the distribution")
}

async function directorySize(root: string): Promise<{ bytes: number; fonts: number }> {
  let bytes = 0
  let fonts = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await directorySize(file)
      bytes += nested.bytes
      fonts += nested.fonts
    } else {
      const size = (await stat(file)).size
      bytes += size
      if (/\.(woff2?|ttf)$/.test(file)) fonts += size
    }
  }
  return { bytes, fonts }
}

export async function measurePackage(resources: string) {
  const asar = await readAsar(path.join(resources, "app.asar"))
  const web = await directorySize(path.join(resources, "remote-web"))
  return {
    asar: (await stat(path.join(resources, "app.asar"))).size,
    web: web.bytes,
    fonts: web.fonts,
    entries: asar.entries,
  }
}

export async function auditPackage(resources: string) {
  const report = await measurePackage(resources)
  assertPackageEntries(report.entries)
  if (report.fonts > 13_000_000) throw new Error(`Remote font budget exceeded: ${report.fonts}`)
  console.log(
    `[package-content] verified files=${report.entries.length} asar=${report.asar} remoteWeb=${report.web} remoteFonts=${report.fonts}`,
  )
  return report
}

if (import.meta.main) {
  const [resources, baseline] = process.argv.slice(2)
  if (!resources) throw new Error("Usage: bun scripts/package-content.ts <Resources> [baseline Resources]")
  const after = await auditPackage(resources)
  if (baseline) {
    const before = await measurePackage(baseline)
    for (const key of ["asar", "web", "fonts"] as const) {
      console.log(
        `[package-content] ${key} before=${before[key]} after=${after[key]} saved=${before[key] - after[key]}`,
      )
    }
  }
}
