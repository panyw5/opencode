#!/usr/bin/env bun
/**
 * Publish a packages/extensions/<name> extension to the panyw5/open-extensions
 * release repository (see AGENTS.md "WLS extension release exception").
 *
 * Usage:
 *   bun script/extension-publish.ts <name> [--repo-dir <path>] [--no-build] [--dry-run]
 *
 * Flow (artifact before descriptor, per specs/extensions/release-authoring.md):
 *   1. build the extension (skip with --no-build; dist must already exist)
 *   2. sync source + dist into <repo-dir>/<name>/ and commit + push
 *   3. npm pack --offline → <pkg>-<version>.tgz
 *   4. gh release create <name>-v<version> (fails if the tag exists with a
 *      different artifact sha256; bump the extension version first)
 *   5. script/extension-release.ts → <repo-dir>/<name>/stable.json
 *   6. commit + push the descriptor
 *
 * --dry-run performs steps 1-3 and writes stable.json locally, without
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
  --dry-run     build/sync/pack/descriptor only; no commits, push or release
`

const EXCLUDE = new Set(["node_modules", ".git", "artifacts", ".DS_Store"])

function copyTree(src: string, dst: string) {
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (from) => !EXCLUDE.has(path.basename(from)) && !path.basename(from).endsWith(".tgz"),
  })
}

function repoGitignore(dir: string) {
  const file = path.join(dir, ".gitignore")
  if (!fs.existsSync(file)) fs.writeFileSync(file, "node_modules/\nartifacts/\n*.tgz\n.DS_Store\n")
}

function repoReadme(dir: string) {
  const file = path.join(dir, "README.md")
  if (fs.existsSync(file)) return
  fs.writeFileSync(
    file,
    `# open-extensions

Independent release repository for OpenCode extensions. Each directory is a
self-contained extension (including a committed, prebuilt \`dist/\` because
\`@opencode-ai/extension-kit\` is not publicly published, so extensions cannot
be rebuilt outside the monorepo).

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
  const src = path.join(EXTENSIONS, name)
  if (!fs.statSync(src, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`No such extension: packages/extensions/${name}`)
  const push = !values["dry-run"]

  const pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")) as {
    name: string
    version: string
    opencode?: { id: string; displayName?: string }
  }
  const version = pkg.version
  const tag = `${name}-v${version}`
  const title = `${pkg.opencode?.displayName ?? name} v${version}`
  console.log(`=== ${name} ${version} -> ${RELEASE_REPO} (tag ${tag}) ===`)

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

  console.log("\n--- sync source ---")
  const dst = path.join(repoDir, name)
  copyTree(src, dst)

  if (push) {
    await $`git add -A`.cwd(repoDir)
    const staged = (await $`git diff --cached --name-only`.cwd(repoDir).text()).trim()
    if (staged) {
      await $`git commit -m ${`${name}: sync v${version}`}`.cwd(repoDir)
      await $`git push -u origin main`.cwd(repoDir)
    } else {
      console.log("(no source changes)")
    }
  }

  console.log("\n--- pack ---")
  // realpath: macOS /var -> /private/var would trip the author's symlink checks.
  const out = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "extension-publish-")))
  const packed = (await $`npm pack --offline --pack-destination ${out}`.cwd(dst).text())
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
      console.log("published artifact sha256 matches; re-uploading identical archive")
      await $`gh release upload ${tag} ${archive} --repo ${RELEASE_REPO} --clobber`
    } else {
      await $`gh release create ${tag} ${archive} --repo ${RELEASE_REPO} --title ${title} --target main --notes ${`Extension ${tag}`}`
    }
  }

  console.log("\n--- stable.json ---")
  const descriptor = path.join(dst, "stable.json")
  fs.rmSync(descriptor, { force: true })
  await $`bun run ${path.join(ROOT, "script", "extension-release.ts")} --archive ${archive} --artifact-url ${artifactUrl} --output ${descriptor} --manifest ${path.join(dst, "package.json")}`

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
