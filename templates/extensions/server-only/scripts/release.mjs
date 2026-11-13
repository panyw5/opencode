import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { isIP } from "node:net"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, promisify } from "node:util"

const execute = promisify(execFile)
const templateRoot = fileURLToPath(new URL("../", import.meta.url))
const number = "(?:0|[1-9][0-9]*)"
const prerelease = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
// Canonical SemVer only: no v prefix, leading zeroes, ranges, or surrounding whitespace.
const versionPattern = new RegExp(
  `^${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
)

class ReleaseError extends Error {}
function fail(message) {
  throw new ReleaseError(message)
}

function artifactURL(value) {
  if (
    typeof value !== "string" ||
    value.length > 16_384 ||
    /[\s\\\u0000-\u001f\u007f]/u.test(value) ||
    value.includes("#")
  )
    fail("Artifact URL must be absolute HTTPS without credentials, whitespace, backslashes, or fragments")
  const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1]
  if (!authority || /[@%]/.test(authority))
    fail("Artifact URL must have an explicit HTTPS authority without credentials")
  let url
  try {
    url = new URL(value)
  } catch {
    fail("Artifact URL is invalid")
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) fail("Artifact URL is invalid")
  const rawHost = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0]
  if (isIP(url.hostname) === 4 && rawHost.toLowerCase() !== url.hostname)
    fail("Artifact URL must not use an encoded IP address")
  if (url.href.length > 16_384) fail("Artifact URL is too long")
  return url.href
}

async function absent(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error.code === "ENOENT") return
    fail("Cannot inspect output path")
  }
  fail("Output already exists; no files will be overwritten")
}

async function bytes(path, limit) {
  if (!(await lstat(path)).isFile()) fail("Expected a regular file, not a symlink or directory")
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) fail("File exceeds the allowed size or is not regular")
    const value = await file.readFile()
    if (value.length > limit) fail("File exceeds the allowed size")
    return value
  } finally {
    await file.close()
  }
}

function manifest(snapshot) {
  let pkg
  try {
    pkg = JSON.parse(snapshot.toString("utf8"))
  } catch {
    fail("package.json must contain valid JSON")
  }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) fail("Invalid package.json")
  if (
    typeof pkg.name !== "string" ||
    pkg.name.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name)
  )
    fail("package.json must have a valid lowercase npm package name")
  if (
    typeof pkg.version !== "string" ||
    pkg.version.length > 256 ||
    !versionPattern.test(pkg.version) ||
    pkg.version
      .split(/[.+-]/)
      .slice(0, 3)
      .some((part) => !Number.isSafeInteger(Number(part)))
  )
    fail("package.json must have a canonical SemVer version")
  if (
    typeof pkg.opencode?.id !== "string" ||
    pkg.opencode.id.length > 64 ||
    !/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(pkg.opencode.id)
  )
    fail("package.json must have a valid opencode.id")
  if (pkg.type !== "module" || pkg.exports?.["./server"] !== "./src/server.js")
    fail("package.json must export ./server as ./src/server.js in an ESM package")
  if ("workspaces" in pkg || /(?:workspace|catalog):/.test(JSON.stringify(pkg)))
    fail("Workspace and catalog references are not supported")
  for (const key of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    if (key in pkg && (!pkg[key] || typeof pkg[key] !== "object" || Object.keys(pkg[key]).length))
      fail("This standalone template must not have dependencies")
  }
  if (!Array.isArray(pkg.files) || pkg.files.length !== 1 || pkg.files[0] !== "src")
    fail('package.json files must be ["src"]')
  return pkg
}

function packed(stdout, pkg, filename) {
  let result
  try {
    result = JSON.parse(stdout)
  } catch {
    fail("npm pack did not return valid JSON")
  }
  if (!Array.isArray(result) || result.length !== 1) fail("npm pack must return exactly one package")
  const item = result[0]
  if (!item || item.name !== pkg.name || item.version !== pkg.version || item.filename !== filename)
    fail("npm pack identity does not match the package.json snapshot")
  if (typeof item.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity))
    fail("npm pack must report SHA-512 integrity")
  if (!Array.isArray(item.files) || !item.files.length) fail("npm pack must report the packaged files")
  const paths = new Set()
  for (const file of item.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      paths.has(file.path) ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => !part || part === "." || part === "..")
    )
      fail("npm pack reported an invalid file list")
    if (
      !(
        file.path === "package.json" ||
        file.path.startsWith("src/") ||
        /^(?:readme|licen[cs]e)(?:\.[^/]+)?$/i.test(file.path)
      )
    )
      fail("npm pack included files outside src and default package documentation")
    paths.add(file.path)
  }
  if (!paths.has("package.json") || !paths.has("src/server.js"))
    fail("npm pack is missing package.json or src/server.js")
  return item
}

function digest(value, algorithm, encoding) {
  return createHash(algorithm).update(value).digest(encoding)
}

/** Local files only. Run via npm scripts, or provide the real npm-cli.js as npmExecPath.
 * root defaults to this template's root; output is resolved relative to root.
 * Returns { archive, output, descriptor }; output/descriptor are null for packOnly.
 */
export async function release(options = {}) {
  const { root = templateRoot, artifactUrl, output, packOnly = false, npmExecPath = process.env.npm_execpath } = options
  if (typeof root !== "string" || !root || typeof packOnly !== "boolean") fail("Invalid release options")
  if (packOnly && (artifactUrl !== undefined || output !== undefined))
    fail("--pack-only cannot be combined with release arguments")
  const url = packOnly ? null : artifactURL(artifactUrl)
  if (!packOnly && (typeof output !== "string" || !output || /[\u0000-\u001f\u007f]/.test(output)))
    fail("Release requires --output")
  if (typeof npmExecPath !== "string" || !npmExecPath)
    fail("Run through npm run pack/release, or provide npmExecPath pointing to npm-cli.js")
  const cwd = resolve(root)
  const pkgPath = join(cwd, "package.json")
  const snapshot = await bytes(pkgPath, 1024 * 1024)
  const pkg = manifest(snapshot)
  const filename = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`
  const artifacts = join(cwd, "artifacts")
  const archive = join(artifacts, filename)
  const destination = packOnly ? null : resolve(cwd, output)
  if (destination === archive) fail("Descriptor output must differ from the archive path")
  await absent(archive)
  if (destination) await absent(destination)
  await mkdir(artifacts, { recursive: true })
  if (!(await lstat(artifacts)).isDirectory()) fail("artifacts must be a directory, not a symlink")
  if (destination && !(await lstat(dirname(destination))).isDirectory())
    fail("Descriptor parent directory must already exist and not be a symlink")
  const npm = await realpath(npmExecPath)
  if (!(await lstat(npm)).isFile()) fail("npmExecPath must point to npm-cli.js")

  const temporary = await mkdtemp(join(tmpdir(), "opencode-extension-release-"))
  let archiveCreated = false
  let descriptorCreated = false
  try {
    const pack = join(temporary, "pack")
    await mkdir(pack)
    const config = await open(join(temporary, "npmrc"), "wx")
    await config.close()
    const globalConfig = await open(join(temporary, "global-npmrc"), "wx")
    await globalConfig.close()
    // npm < 11 runs prepare during pack even with --ignore-scripts; the flag
    // only covers pack-time lifecycle scripts from npm 11. Stage a copy with
    // those hooks removed so package scripts never execute, on any npm.
    const stage = join(temporary, "stage")
    await cp(cwd, stage, { recursive: true })
    for (const name of ["node_modules", ".git", "artifacts"]) await rm(join(stage, name), { recursive: true, force: true })
    if (destination) {
      const inside = relative(cwd, destination)
      if (inside && !inside.startsWith("..") && !isAbsolute(inside))
        await rm(join(stage, inside), { force: true })
    }
    const stagedManifestPath = join(stage, "package.json")
    const stagedManifest = JSON.parse(await readFile(stagedManifestPath, "utf8"))
    if (stagedManifest && typeof stagedManifest === "object" && stagedManifest.scripts) {
      for (const hook of ["prepublish", "prepublishOnly", "prepublishMany", "prepare", "prepack", "postpack"])
        delete stagedManifest.scripts[hook]
      if (!Object.keys(stagedManifest.scripts).length) delete stagedManifest.scripts
    }
    const stagedBytes = Buffer.from(`${JSON.stringify(stagedManifest, null, 2)}\n`)
    await writeFile(stagedManifestPath, stagedBytes)
    let stdout
    try {
      ;({ stdout } = await execute(
        process.execPath,
        [npm, "pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", pack],
        {
          cwd: stage,
          env: {
            ...process.env,
            npm_config_cache: join(temporary, "cache"),
            npm_config_logs_dir: join(temporary, "logs"),
            npm_config_userconfig: join(temporary, "npmrc"),
            npm_config_globalconfig: join(temporary, "global-npmrc"),
            npm_config_update_notifier: "false",
            npm_config_audit: "false",
            npm_config_fund: "false",
          },
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 120_000,
          windowsHide: true,
        },
      ))
    } catch {
      fail("npm pack failed; no release files were created")
    } finally {
      if (
        !(await bytes(pkgPath, 1024 * 1024)).equals(snapshot) ||
        !(await bytes(stagedManifestPath, 1024 * 1024)).equals(stagedBytes)
      )
        fail("package.json changed during npm pack; release aborted")
    }
    const info = packed(stdout, pkg, filename)
    const source = join(pack, filename)
    const packedBytes = await bytes(source, 64 * 1024 * 1024)
    if (`sha512-${digest(packedBytes, "sha512", "base64")}` !== info.integrity)
      fail("npm pack integrity does not match the archive bytes")
    await copyFile(source, archive, constants.COPYFILE_EXCL)
    archiveCreated = true
    const finalBytes = await bytes(archive, 64 * 1024 * 1024)
    if (`sha512-${digest(finalBytes, "sha512", "base64")}` !== info.integrity)
      fail("Final archive integrity does not match npm pack")
    const descriptor = packOnly
      ? null
      : {
          schemaVersion: 1,
          id: pkg.opencode.id,
          version: pkg.version,
          artifact: { url, sha256: digest(finalBytes, "sha256", "hex") },
        }
    if (destination) {
      const file = await open(destination, "wx")
      descriptorCreated = true
      try {
        await file.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`)
      } finally {
        await file.close()
      }
    }
    return { archive, output: destination, descriptor }
  } catch (error) {
    if (descriptorCreated) await rm(destination, { force: true })
    if (archiveCreated) await rm(archive, { force: true })
    throw error
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function cli() {
  let values
  try {
    ;({ values } = parseArgs({
      options: { "artifact-url": { type: "string" }, output: { type: "string" }, "pack-only": { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    }))
    // parseArgs accepts repeated flags; reject them rather than silently taking the last value.
    const flags = process.argv
      .slice(2)
      .filter((value) => /^--(?:artifact-url|output|pack-only)(?:=|$)/.test(value))
      .map((value) => value.split("=")[0])
    if (new Set(flags).size !== flags.length) fail("Duplicate command-line arguments")
  } catch {
    fail("Invalid command-line arguments; use --artifact-url URL --output FILE, or --pack-only")
  }
  const result = await release({
    artifactUrl: values["artifact-url"],
    output: values.output,
    packOnly: values["pack-only"] ?? false,
  })
  console.log(JSON.stringify(result))
}

if (
  process.argv[1] &&
  (await realpath(resolve(process.argv[1])).catch(() => null)) === (await realpath(fileURLToPath(import.meta.url)))
) {
  cli().catch((error) => {
    // Never print child-process output, raw filesystem errors, or input URLs/query strings.
    console.error(
      `Extension release: ${error instanceof ReleaseError ? error.message : "Local release failed; check package files, output paths, and the npm entry point"}`,
    )
    process.exitCode = 1
  })
}
