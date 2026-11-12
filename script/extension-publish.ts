#!/usr/bin/env bun
/**
 * Publish a packages/extensions/<name> extension to the panyw5/open-extensions
 * release repository (see AGENTS.md "WLS extension release exception").
 *
 * Usage:
 *   bun script/extension-publish.ts <name> [--repo-dir <path>] [--no-build] [--dry-run]
 *
 * Flow (artifact before descriptor, per specs/extensions/release-authoring.md):
 *   0. verify packages/extensions/<name> is clean in the monorepo and record
 *      HEAD; the commit lands in the signed descriptor as source.commit
 *   1. build the extension (skip with --no-build; dist must already exist)
 *   2. npm pack --offline → <pkg>-<version>.tgz (packed from the monorepo tree)
 *   3. gh release create <name>-v<version> (an existing tag with a different
 *      artifact sha256 fails: bump the extension version; an identical artifact
 *      is left untouched because released artifacts are immutable)
 *   4. script/extension-release.ts → <repo-dir>/<name>/stable.json (+ .sig)
 *      sequence = previous descriptor sequence + 1 (or 1 for a first release)
 *   5. commit + push the descriptor and its detached signature
 *
 * The release repository only carries distribution files: <name>/stable.json,
 * <name>/stable.json.sig and READMEs. Extension source is never synced; source
 * trees committed by earlier versions of this script are reported as a stale
 * list for manual review, never deleted automatically.
 *
 * OPENCODE_EXTENSION_SIGNING_KEY must hold the Ed25519 private key (PKCS8 PEM or
 * base64 DER) for real publishes; --dry-run signs only when the key is present.
 *
 * --dry-run performs steps 0-4 and writes stable.json (+ .sig) locally, without
 * committing, pushing or touching GitHub Releases.
 */
import { $ } from "bun"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const RELEASE_REPO = "panyw5/open-extensions"
const ROOT = path.resolve(import.meta.dir, "..")
const EXTENSIONS = path.join(ROOT, "packages", "extensions")

const usage = `Publish an extension to ${RELEASE_REPO}.

Usage:
  bun script/extension-publish.ts <name> [--repo-dir <path>] [--no-build] [--dry-run]

  <name>        directory under packages/extensions (e.g. wls-repl)
  --repo-dir    local checkout of ${RELEASE_REPO} (default: ../open-extensions,
                cloned automatically when missing)
  --no-build    skip "bun run build" in the extension directory
  --dry-run     build/pack/descriptor only; no commits, push or release

Environment:
  OPENCODE_EXTENSION_SIGNING_KEY  Ed25519 private key (PKCS8 PEM or base64 DER)
                                  required for real publishes; signs stable.json
                                  into stable.json.sig without ever logging it
`

function repoGitignore(dir: string) {
  const file = path.join(dir, ".gitignore")
  if (!fs.existsSync(file)) fs.writeFileSync(file, "node_modules/\nartifacts/\n.turbo/\n*.tgz\n.DS_Store\n")
}

function repoReadme(dir: string) {
  const file = path.join(dir, "README.md")
  if (fs.existsSync(file)) return
  fs.writeFileSync(
    file,
    `# open-extensions

Distribution repository for OpenCode extensions. Each \`<extension>/\`
directory carries only release metadata: \`stable.json\`, its detached Ed25519
signature \`stable.json.sig\` and a README. Extension source is not synced
here; it lives in the opencode monorepo under \`packages/extensions/\` and the
\`source.commit\` field in each descriptor records the exact commit a release
was built from.

Install \`.tgz\` archives are distributed through
[GitHub Releases](https://github.com/${RELEASE_REPO}/releases). Each
\`<extension>/stable.json\` is the release descriptor consumed by the
"release URL" install source:

\`\`\`text
https://raw.githubusercontent.com/${RELEASE_REPO}/main/<extension>/stable.json
\`\`\`

Publishing is automated by \`script/extension-publish.ts\` in the opencode
monorepo; do not hand-edit generated \`stable.json\` files.
`,
  )
}

/**
 * Per-extension README. Previously the extension's own README arrived via the
 * source sync; now an existing file is kept untouched and only a missing one
 * gets a generated stub, so docs never silently go stale against the source.
 */
function extensionReadme(dir: string, name: string, pkg: { opencode?: { displayName?: string; description?: string } }) {
  const file = path.join(dir, "README.md")
  if (fs.existsSync(file)) return
  const title = pkg.opencode?.displayName ?? name
  const description = pkg.opencode?.description
  fs.writeFileSync(
    file,
    `# ${title}
${description === undefined ? "" : `\n${description}\n`}
Install through the release descriptor (the "release URL" install source):

\`\`\`text
https://raw.githubusercontent.com/${RELEASE_REPO}/main/${name}/stable.json
\`\`\`

Archives ship as immutable assets on the \`${name}-v*\` releases of
[${RELEASE_REPO}](https://github.com/${RELEASE_REPO}/releases). Source lives in
the opencode monorepo under \`packages/extensions/${name}/\`; \`source.commit\`
in the descriptor records the commit each release was built from.
`,
  )
}

// Files an extension directory in the release repo is allowed to carry.
const KEEP = new Set(["stable.json", "stable.json.sig", "README.md"])
// Top-level entries that are not stale leftovers.
const ROOT_KEEP = new Set([".git", ".gitignore", ".gitattributes", "LICENSE", "README.md"])

/**
 * Files and directories left over in the release repo from the old source-sync
 * publishing flow. They are reported for manual review only — removing them is
 * a destructive operation this script never performs on its own.
 */
function staleEntries(repoDir: string) {
  const stale: string[] = []
  for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue
      for (const item of fs.readdirSync(path.join(repoDir, entry.name), { withFileTypes: true })) {
        if (!KEEP.has(item.name)) stale.push(`${entry.name}/${item.name}${item.isDirectory() ? "/" : ""}`)
      }
    } else if (!ROOT_KEEP.has(entry.name)) {
      stale.push(entry.name)
    }
  }
  return stale.sort()
}

/**
 * sha256 of the artifact currently published under <tag>, when determinable.
 * Primary source is the release asset digest; falls back to the sha256 recorded
 * in the published <name>/stable.json descriptor.
 */
async function publishedSha256(name: string, tag: string, asset: string) {
  const release = await $`gh api ${`repos/${RELEASE_REPO}/releases/tags/${tag}`}`
    .nothrow()
    .quiet()
    .text()
  try {
    const { assets } = JSON.parse(release) as { assets?: { name?: string; digest?: string }[] }
    const digest = assets?.find((item) => item.name === asset)?.digest
    if (digest?.startsWith("sha256:")) return digest.slice("sha256:".length)
  } catch {
    // fall through to the descriptor lookup
  }
  const file = await $`gh api ${`repos/${RELEASE_REPO}/contents/${name}/stable.json`}`
    .nothrow()
    .quiet()
    .text()
  try {
    const { content, encoding } = JSON.parse(file) as { content?: string; encoding?: string }
    if (encoding !== "base64" || !content) return undefined
    const descriptor = JSON.parse(Buffer.from(content, "base64").toString("utf8")) as {
      artifact?: { sha256?: string }
    }
    return descriptor.artifact?.sha256
  } catch {
    return undefined
  }
}

/**
 * Next monotonic sequence for the descriptor. Reads the previously committed
 * stable.json before it is regenerated; a first release starts at 1. A present
 * but invalid counter refuses to guess: the rollback guard in the installer
 * depends on this never moving backwards.
 */
function nextSequence(file: string) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined
  if (!text) return 1
  try {
    const value = (JSON.parse(text) as { sequence?: unknown }).sequence
    if (value === undefined) return 1
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error("not a non-negative integer")
    return value + 1
  } catch {
    throw new Error(`Existing ${path.basename(file)} has an unreadable sequence; refusing to guess the next one`)
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    allowPositionals: true,
    options: {
      "repo-dir": { type: "string" },
      "no-build": { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  })
  if (values.help) {
    process.stdout.write(usage)
    return
  }
  const name = positionals[0]
  if (!name) throw new Error("Missing extension directory name (see --help)")
  if (name.includes("/") || name.includes("..")) throw new Error("Extension name must be a single directory name")
  const signing = process.env.OPENCODE_EXTENSION_SIGNING_KEY !== undefined
  if (!values["dry-run"] && !signing)
    throw new Error("OPENCODE_EXTENSION_SIGNING_KEY is required to publish a signed descriptor")
  const src = path.join(EXTENSIONS, name)
  if (!fs.statSync(src, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`No such extension: packages/extensions/${name}`)
  const push = !values["dry-run"]

  const pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")) as {
    name: string
    version: string
    opencode?: { id: string; displayName?: string; description?: string }
  }
  const version = pkg.version
  const tag = `${name}-v${version}`
  const title = `${pkg.opencode?.displayName ?? name} v${version}`
  console.log(`=== ${name} ${version} -> ${RELEASE_REPO} (tag ${tag}) ===`)

  // Provenance gate: the extension source must sit exactly at the recorded
  // commit so source.commit in the signed descriptor is a faithful record.
  console.log("\n--- provenance ---")
  const commit = (await $`git rev-parse HEAD`.cwd(ROOT).text()).trim()
  const extRel = `packages/extensions/${name}`
  const dirty = (await $`git status --porcelain -- ${extRel}`.cwd(ROOT).text()).trim()
  if (dirty) {
    const detail = `uncommitted changes under ${extRel}:\n${dirty}`
    if (push)
      throw new Error(`Cannot record a faithful source.commit: ${detail}\nCommit or stash them before publishing.`)
    console.log(`warning: ${detail}\n(dry-run continues; a real publish would refuse)`)
  }
  const unrelated = (await $`git status --porcelain`.cwd(ROOT).text())
    .split("\n")
    .filter((line) => line.trim() && !line.slice(3).startsWith(`${extRel}/`))
  if (unrelated.length)
    console.log(
      `note: the monorepo has ${unrelated.length} unrelated uncommitted entr${unrelated.length === 1 ? "y" : "ies"}; source.commit only certifies ${extRel}`,
    )
  console.log(`source.commit: ${commit}`)

  if (!values["no-build"]) {
    console.log("\n--- build ---")
    await $`bun run build`.cwd(src)
  }
  if (!fs.existsSync(path.join(src, "dist", "server.js")))
    throw new Error(`${name}: dist/server.js missing; run without --no-build`)

  let repoDir = path.resolve(values["repo-dir"] ?? path.join(ROOT, "..", "open-extensions"))
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    console.log(`\n--- clone ${RELEASE_REPO} -> ${repoDir} ---`)
    fs.mkdirSync(path.dirname(repoDir), { recursive: true })
    await $`gh repo clone ${RELEASE_REPO} ${repoDir}`
  }
  repoDir = fs.realpathSync(repoDir)
  // An empty clone sits on an unborn branch; make sure it is called "main".
  await $`git symbolic-ref HEAD refs/heads/main`.cwd(repoDir).quiet()

  repoGitignore(repoDir)
  repoReadme(repoDir)
  const license = path.join(repoDir, "LICENSE")
  if (!fs.existsSync(license)) fs.copyFileSync(path.join(ROOT, "LICENSE"), license)

  // Distribution-only layout: the extension directory carries the descriptor,
  // its signature and a README — never a synced source tree.
  const dst = path.join(repoDir, name)
  fs.mkdirSync(dst, { recursive: true })
  extensionReadme(dst, name, pkg)

  const stale = staleEntries(repoDir)
  if (stale.length) {
    console.log("\n--- stale files in release repo ---")
    console.log("left over from the old source-sync flow; kept in place — review and delete manually:")
    for (const item of stale) console.log(`  ${item}`)
  }

  console.log("\n--- pack ---")
  // realpath: macOS /var -> /private/var would trip the author's symlink checks.
  const out = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "extension-publish-")))
  const packed = (await $`npm pack --offline --pack-destination ${out}`.cwd(src).text())
    .trim()
    .split("\n")
    .at(-1)!
    .trim()
  const archive = path.join(out, packed)
  if (!fs.existsSync(archive)) throw new Error(`npm pack did not produce ${archive}`)
  console.log(`archive: ${archive}`)

  const artifactUrl = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${packed}`
  if (push) {
    console.log("\n--- release ---")
    const exists =
      (await $`gh release view ${tag} --repo ${RELEASE_REPO} --json tagName`.nothrow().quiet()).exitCode === 0
    if (exists) {
      const local = createHash("sha256").update(fs.readFileSync(archive)).digest("hex")
      const published = await publishedSha256(name, tag, packed)
      if (published !== local) {
        throw new Error(
          `${tag} is already published` +
            (published
              ? ` with a different artifact (sha256 ${published})`
              : " and its artifact sha256 could not be determined") +
            `; local sha256 ${local}. Bump "version" in packages/extensions/${name}/package.json first.`,
        )
      }
      console.log("published artifact sha256 matches; skipping upload (release artifacts are immutable)")
    } else {
      await $`gh release create ${tag} ${archive} --repo ${RELEASE_REPO} --title ${title} --target main --notes ${`Extension ${tag}`}`
    }
  }

  console.log("\n--- stable.json ---")
  const descriptor = path.join(dst, "stable.json")
  const signature = `${descriptor}.sig`
  // The previous descriptor carries the monotonic sequence; read it before it
  // is regenerated below.
  const sequence = nextSequence(descriptor)
  fs.rmSync(descriptor, { force: true })
  fs.rmSync(signature, { force: true })
  if (!signing) console.log("warning: OPENCODE_EXTENSION_SIGNING_KEY not set; descriptor left unsigned (dry-run)")
  const args = [
    "--archive",
    archive,
    "--artifact-url",
    artifactUrl,
    "--output",
    descriptor,
    "--manifest",
    path.join(src, "package.json"),
    "--sequence",
    String(sequence),
    "--source-commit",
    commit,
    ...(signing ? ["--signature", signature] : []),
  ]
  await $`bun run ${path.join(ROOT, "script", "extension-release.ts")} ${args}`

  if (push) {
    await $`git add -A`.cwd(repoDir)
    const staged = (await $`git diff --cached --name-only`.cwd(repoDir).text()).trim()
    if (staged) {
      await $`git commit -m ${`${name}: release v${version} descriptor`}`.cwd(repoDir)
      await $`git push origin main`.cwd(repoDir)
    }
  }

  console.log(`\n=== done ===`)
  console.log(`descriptor : https://raw.githubusercontent.com/${RELEASE_REPO}/main/${name}/stable.json`)
  console.log(`artifact   : ${artifactUrl}`)
  if (!push) console.log("(dry-run: nothing was committed, pushed or released)")
}

await main().catch((error: unknown) => {
  process.stderr.write(`extension-publish: ${error instanceof Error ? error.message : "failed"}\n`)
  process.exitCode = 1
})
