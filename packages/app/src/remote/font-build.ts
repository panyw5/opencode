import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import manifest from "../../../ui/src/assets/fonts-remote/manifest.json"

const assets = fileURLToPath(new URL("../../../ui/src/assets/", import.meta.url))
const sourceRoot = resolve(assets, "fonts")
const compactRoot = resolve(assets, "fonts-remote")

export function verifyRemoteFonts() {
  for (const [name, record] of Object.entries(manifest)) {
    for (const [root, hash] of [
      [sourceRoot, record.source],
      [compactRoot, record.output],
    ]) {
      const actual = createHash("sha256")
        .update(readFileSync(resolve(root, name)))
        .digest("hex")
      if (actual !== hash)
        throw new Error(`Remote font is stale: ${name}; run packages/ui/script/subset-remote-fonts.py`)
    }
  }
}

export function remoteFonts(): Plugin {
  return {
    name: "opencode:remote-fonts",
    apply: "build",
    enforce: "pre",
    buildStart() {
      verifyRemoteFonts()
      const records = Object.values(manifest)
      const before = records.reduce((total, record) => total + record.before, 0)
      const after = records.reduce((total, record) => total + record.after, 0)
      console.log(`[remote-fonts] verified=${records.length} before=${before} after=${after} saved=${before - after}`)
    },
    async resolveId(id, importer) {
      if (!id.endsWith(".woff2")) return
      const resolved = await this.resolve(id, importer, { skipSelf: true })
      if (!resolved || dirname(resolve(resolved.id)) !== sourceRoot) return
      const name = basename(resolved.id)
      if (Object.hasOwn(manifest, name)) return resolve(compactRoot, name)
    },
  }
}
