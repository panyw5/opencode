import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { isShareableRendererAsset } from "../src/main/shared-renderer-assets"

export function findSharedRendererAssets(renderer: string, remote: string) {
  const assets = join(renderer, "assets")
  if (!existsSync(assets)) return []

  return readdirSync(assets, { withFileTypes: true }).flatMap((entry) => {
    const relative = `assets/${entry.name}`
    if (!entry.isFile() || !isShareableRendererAsset(relative)) return []
    const local = join(renderer, relative)
    const shared = join(remote, relative)
    const target = lstatSync(shared, { throwIfNoEntry: false })
    if (!target?.isFile() || !target.size || lstatSync(local).size !== target.size) return []
    return readFileSync(local).equals(readFileSync(shared)) ? [relative] : []
  }).sort()
}
