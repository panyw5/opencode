import { lstat, mkdir, readFile, realpath, symlink } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Offline test setup only: write links beneath this prototype, never into the donor checkout.
const donor = process.argv[2]
if (!donor || !path.isAbsolute(donor)) {
  throw new Error("Usage: node scripts/reuse-installed.mjs /absolute/path/to/already-installed/repository")
}
const root = fileURLToPath(new URL("../", import.meta.url))
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
const resolvers = ["packages/opencode/package.json", "packages/desktop/package.json", "package.json"].map((file) =>
  createRequire(path.join(donor, file)),
)
const links = []
for (const [name, version] of Object.entries(manifest.devDependencies)) {
  let source
  for (const require of resolvers) {
    try {
      const file = require.resolve(`${name}/package.json`)
      const installed = JSON.parse(await readFile(file, "utf8"))
      if (installed.version === version) {
        source = await realpath(path.dirname(file))
        break
      }
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ENOENT") throw error
    }
  }
  if (!source) throw new Error(`Missing installed ${name}@${version}; no install or network fallback is performed`)
  const destination = path.join(root, "node_modules", name)
  const existing = await lstat(destination).catch((error) => {
    if (error.code !== "ENOENT") throw error
  })
  if (existing && (!existing.isSymbolicLink() || (await realpath(destination)) !== source)) {
    throw new Error(`Refusing to replace existing dependency: ${destination}`)
  }
  links.push({ name, version, source, destination, existing: Boolean(existing) })
}
for (const link of links) {
  if (!link.existing) {
    await mkdir(path.dirname(link.destination), { recursive: true })
    await symlink(link.source, link.destination, "dir")
  }
  console.info(`reuse-installed ${link.name}@${link.version} -> ${link.source}`)
}
