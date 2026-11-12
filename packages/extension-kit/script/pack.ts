#!/usr/bin/env bun
// Packs @opencode-ai/extension-kit into a publishable .tgz.
//
// The checked-in package.json resolves every export at ./src so the monorepo
// consumes the TypeScript sources directly (no build step required in-repo).
// For distribution the exports map is rewritten in place while packing:
// `types`/`import`/`default` point at the compiled dist/*.{d.ts,js} output of
// `bun run build`, and `development` keeps pointing at the shipped sources so
// dev-mode builds of consumers resolve the same code the monorepo does.
//
// Modes:
//   bun ./script/pack.ts [--outdir <dir>]  build, rewrite, `npm pack`, restore;
//                                        prints the tarball path
//   bun ./script/pack.ts --apply           build + rewrite exports in place
//                                          (runs as the `prepack` lifecycle
//                                          hook so a bare `npm pack` also
//                                          produces a distributable tarball)
//   bun ./script/pack.ts --restore         restore package.json from the
//                                          backup left by --apply (postpack)
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"

const dir = path.resolve(import.meta.dir, "..")
const pkgFile = path.join(dir, "package.json")
const backupFile = path.join(dir, "script", ".package.json.pack-backup")

type ExportEntry = string | Record<string, string | string[]>

/** src/*.ts entries become dist-backed exports; plain .js assets stay as-is. */
function packedConditions(target: string): Record<string, string> {
  if (target.startsWith("./src/") && target.endsWith(".ts")) {
    const js = target.replace("./src/", "./dist/").replace(/\.ts$/, ".js")
    const dts = js.replace(/\.js$/, ".d.ts")
    for (const file of [js, dts]) {
      if (!existsSync(path.join(dir, file))) {
        throw new Error(`dist output missing for export target ${target} (expected ${file}); run "bun run build" first`)
      }
    }
    return { types: dts, development: target, import: js, default: js }
  }
  if (target.endsWith(".js")) {
    const conditions: Record<string, string> = {}
    const dts = target.replace(/\.js$/, ".d.ts")
    if (existsSync(path.join(dir, dts))) conditions.types = dts
    conditions.development = target
    conditions.default = target
    return conditions
  }
  return { default: target }
}

function rewriteExports(pkg: { exports: Record<string, ExportEntry> }) {
  const next: Record<string, Record<string, string>> = {}
  for (const [key, value] of Object.entries(pkg.exports)) {
    const target = typeof value === "string" ? value : (value.default ?? value.import)
    if (typeof target !== "string") throw new Error(`unsupported exports shape for ${key}: ${JSON.stringify(value)}`)
    next[key] = packedConditions(target)
  }
  pkg.exports = next
}

async function apply() {
  // A leftover backup means a previous pack crashed between apply/restore;
  // restore it first so the rewrite always starts from the checked-in shape.
  if (existsSync(backupFile)) await restore()
  await $`bun run build`.cwd(dir)
  const original = await Bun.file(pkgFile).text()
  await Bun.write(backupFile, original)
  const pkg = JSON.parse(original)
  rewriteExports(pkg)
  await Bun.write(pkgFile, JSON.stringify(pkg, null, 2) + "\n")
}

async function restore() {
  if (!existsSync(backupFile)) return
  await Bun.write(pkgFile, await Bun.file(backupFile).text())
  await rm(backupFile)
}

const args = process.argv.slice(2)

if (args.includes("--apply")) {
  await apply()
} else if (args.includes("--restore")) {
  await restore()
} else {
  const outdirIndex = args.indexOf("--outdir")
  const outdir = path.resolve(outdirIndex >= 0 && args[outdirIndex + 1] ? args[outdirIndex + 1] : ".")
  if (!existsSync(outdir)) throw new Error(`--outdir does not exist: ${outdir}`)
  await apply()
  try {
    // --ignore-scripts so this pack does not re-enter the prepack hook; the
    // rewrite above already produced the distribution exports map.
    const result = await $`npm pack --ignore-scripts --pack-destination ${dir}`.cwd(dir).text()
    const filename = result.trim().split("\n").at(-1)
    if (!filename || !filename.endsWith(".tgz")) throw new Error(`npm pack did not report a tarball: ${result}`)
    const tarball = path.join(dir, filename)
    const target = path.join(outdir, filename)
    // copy+rm instead of rename: --outdir may live on a different filesystem.
    await Bun.write(target, Bun.file(tarball))
    await rm(tarball)
    console.log(`packed: ${target}`)
  } finally {
    await restore()
  }
}
