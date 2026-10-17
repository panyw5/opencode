import npa from "npm-package-arg"
import semver from "semver"
import path from "node:path"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"

/** Deliberately not a general npm installer: no npmrc, aliases, scripts, bins or implicit peer installation. */
export type NpmTransport = (url: string, options: { signal?: AbortSignal }) => Promise<unknown>
type Declarations = {
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  peerDependencies: Record<string, string>
  optionalPeers: string[]
}
export type NpmNode = Readonly<{
  directory: string
  parent: string | null
  name: string
  version: string
  integrity: string
  tarball: string
  declarations: Declarations
  dependencies: Record<string, string>
}>
export type PreparedNpm = Readonly<{
  name: string
  version: string
  registry: string
  integrity: string
  tarball: string
  dependencies: Record<string, string>
  graph: readonly NpmNode[]
  lockDigest: string
}>
export type NpmDownload = (input: { url: string; integrity: string; signal?: AbortSignal }) => Promise<Uint8Array>
export type NpmExtract = (input: Uint8Array, options: { directory: string; signal?: AbortSignal }) => Promise<unknown>

const preparedTokens = new WeakSet<object>()
const MAX_NODES = 256
const MAX_DEPTH = 20
const MAX_EDGES = 256
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
function fail(message: string): never {
  throw new Error(`Strict npm: ${message}`)
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid registry manifest")
  return value as Record<string, unknown>
}
const sorted = <T>(value: Record<string, T>) =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const aborted = (signal?: AbortSignal) => signal?.throwIfAborted()

function packageSpec(spec: string, name?: string, peer = false) {
  let parsed: ReturnType<typeof npa>
  try {
    parsed = name ? npa.resolve(name, spec) : npa(spec)
  } catch {
    return fail(`invalid package spec ${spec}`)
  }
  if (
    !parsed.name ||
    (name && parsed.name !== name) ||
    !parsed.registry ||
    !["version", "range", ...(peer ? [] : ["tag"])].includes(parsed.type)
  ) {
    return fail(`registry-only package spec required: ${name ? `${name}@` : ""}${spec}`)
  }
  // npm-package-arg also accepts legacy/URL-encoded names; paths are built only from canonical names.
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(parsed.name) ||
    parsed.name.split("/").some((part) => part === "." || part === ".." || part === "node_modules")
  ) {
    return fail(`unsupported package name ${parsed.name}`)
  }
  return parsed
}

function declarations(manifest: Record<string, unknown>): Declarations {
  const maps = ["dependencies", "optionalDependencies", "peerDependencies"] as const
  const result = {} as Declarations
  for (const key of maps) {
    const values = manifest[key] === undefined ? {} : record(manifest[key])
    if (Object.keys(values).length > MAX_EDGES) fail("too many dependency declarations")
    const entries = Object.entries(values).map(([name, spec]) => {
      if (typeof spec !== "string") return fail(`invalid dependency ${name}`)
      packageSpec(spec, name, key === "peerDependencies")
      return [name, spec] as const
    })
    result[key] = sorted(Object.fromEntries(entries))
  }
  const meta = manifest.peerDependenciesMeta === undefined ? {} : record(manifest.peerDependenciesMeta)
  result.optionalPeers = Object.keys(meta)
    .filter((name) => {
      if (!own(result.peerDependencies, name)) fail(`peer metadata without a peer declaration: ${name}`)
      const value = record(meta[name])
      if (value.optional !== undefined && typeof value.optional !== "boolean") fail("invalid optional peer metadata")
      return value.optional === true
    })
    .sort()
  for (const key of ["bundleDependencies", "bundledDependencies"]) {
    const value = manifest[key]
    if (value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0)) {
      fail("bundled dependencies are unsupported")
    }
  }
  if (manifest.gypfile === true) fail("native/build-required packages are unsupported")
  /** Actual package.json fields are normalized for comparison, never passed to an npm installer. */
  const scripts = manifest.scripts === undefined ? {} : record(manifest.scripts)
  for (const script of Object.values(scripts)) {
    if (typeof script !== "string") fail("invalid package script")
    if (/\b(?:node-gyp|node-pre-gyp|prebuild-install|cmake-js|node-gyp-build)\b/i.test(script)) {
      fail("native/build-required packages are unsupported")
    }
  }
  for (const [key, current] of [
    ["os", process.platform],
    ["cpu", process.arch],
  ] as const) {
    const values = manifest[key]
    if (values === undefined) continue
    if (!Array.isArray(values) || !values.every((x) => typeof x === "string")) fail(`invalid ${key} constraint`)
    if (
      values.includes(`!${current}`) ||
      (values.some((x) => !x.startsWith("!")) && !values.includes(current) && !values.includes("any"))
    ) {
      fail(`unsupported ${key} constraint`)
    }
  }
  return result
}

function registryURL(input: string) {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return fail("invalid registry URL")
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    fail("HTTPS registry URL required")
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`
  return url
}

function tarballURL(input: unknown, registry: URL) {
  if (typeof input !== "string") return fail("missing registry tarball")
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return fail("invalid registry tarball")
  }
  if (url.protocol !== "https:" || url.origin !== registry.origin || url.username || url.password || url.hash) {
    fail("tarball must use the configured registry origin")
  }
  return url.href
}

function integrity(input: unknown) {
  if (typeof input !== "string") return fail("strong tarball integrity is required")
  for (const [algorithm, length] of [
    ["sha512", 64],
    ["sha384", 48],
    ["sha256", 32],
  ] as const) {
    for (const token of input.trim().split(/\s+/)) {
      if (!token.startsWith(`${algorithm}-`)) continue
      const encoded = token.slice(algorithm.length + 1)
      const bytes = Buffer.from(encoded, "base64")
      if (bytes.length !== length || bytes.toString("base64") !== encoded) fail("invalid strong tarball integrity")
      return token
    }
  }
  return fail("strong tarball integrity is required")
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Fetches ONLY registry metadata. Every installed and peer edge is checked before any tarball is requested. */
export async function resolveNpm(
  spec: string,
  options: { registry?: string; transport: NpmTransport; signal?: AbortSignal },
): Promise<PreparedNpm> {
  const root = packageSpec(spec)
  const registry = registryURL(options.registry ?? "https://registry.npmjs.org/")
  const cache = new Map<string, Promise<Record<string, unknown>>>()
  const graph: NpmNode[] = []
  const byDirectory = new Map<string, NpmNode>()
  const metadata = (name: string) => {
    const cached = cache.get(name)
    if (cached) return cached
    const response = (async () => {
      aborted(options.signal)
      const body = record(
        await options.transport(new URL(encodeURIComponent(name), registry).href, { signal: options.signal }),
      )
      if (body.name !== name) fail(`registry package name mismatch: ${name}`)
      return body
    })()
    cache.set(name, response)
    return response
  }
  const visit = async (
    name: string,
    requested: string,
    parent: NpmNode | undefined,
    depth: number,
  ): Promise<NpmNode> => {
    aborted(options.signal)
    if (depth > MAX_DEPTH || graph.length >= MAX_NODES) fail("dependency graph limit exceeded")
    const parsed = packageSpec(requested, name)
    const requestedVersion = parsed.fetchSpec ?? fail("missing registry version spec")
    const body = await metadata(name)
    const versions = record(body.versions)
    if (Object.keys(versions).length > 20000) fail("registry version limit exceeded")
    let version: string | null | undefined
    if (parsed.type === "tag") {
      const tags = record(body["dist-tags"])
      const target = own(tags, requestedVersion) ? tags[requestedVersion] : undefined
      version = typeof target === "string" ? target : undefined
    } else {
      version = semver.maxSatisfying(
        Object.keys(versions).filter((v) => semver.valid(v) === v),
        requestedVersion,
      )
    }
    if (!version || semver.valid(version) !== version || !own(versions, version))
      fail(`no matching registry version: ${name}@${requested}`)
    const manifest = record(versions[version])
    if (manifest.name !== name || manifest.version !== version) fail("registry version identity mismatch")
    const declared = declarations(manifest)
    const dist = record(manifest.dist)
    const directory = parent ? `${parent.directory}/node_modules/${name}` : "package"
    let ancestor = parent
    while (ancestor) {
      if (ancestor.name === name && ancestor.version === version) fail("cyclic dependency graphs are unsupported")
      ancestor = ancestor.parent ? byDirectory.get(ancestor.parent) : undefined
    }
    const dependencies: Record<string, string> = {}
    const node: NpmNode = {
      directory,
      parent: parent?.directory ?? null,
      name,
      version,
      integrity: integrity(dist.integrity),
      tarball: tarballURL(dist.tarball, registry),
      declarations: declared,
      dependencies,
    }
    graph.push(node)
    byDirectory.set(directory, node)
    // Validate ALL declarations before fetching even the next package's metadata.
    for (const [child, range] of Object.entries(
      sorted({ ...declared.dependencies, ...declared.optionalDependencies }),
    )) {
      const installed = await visit(child, range, node, depth + 1)
      dependencies[child] = installed.directory
    }
    return node
  }
  const first = await visit(root.name!, root.rawSpec, undefined, 0)
  for (const node of graph) {
    for (const [name, range] of Object.entries(node.declarations.peerDependencies)) {
      let owner: NpmNode | undefined = node
      let target: NpmNode | undefined
      while (owner && !target) {
        target = byDirectory.get(owner.dependencies[name])
        owner = owner.parent ? byDirectory.get(owner.parent) : undefined
      }
      if (!target && node.declarations.optionalPeers.includes(name)) continue
      if (!target || !semver.satisfies(target.version, range))
        fail(`unsatisfied peer: ${node.name} requires ${name}@${range}`)
    }
  }
  aborted(options.signal)
  const locked = {
    name: first.name,
    version: first.version,
    registry: registry.href,
    integrity: first.integrity,
    tarball: first.tarball,
    dependencies: first.dependencies,
    graph,
  }
  const prepared = freeze({ ...locked, lockDigest: digest(locked) })
  preparedTokens.add(prepared)
  return prepared
}

async function verifyExtracted(
  directory: string,
  node: NpmNode,
  budget: { files: number; bytes: number },
  signal?: AbortSignal,
) {
  aborted(signal)
  const manifest = record(JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")))
  if (
    manifest.name !== node.name ||
    manifest.version !== node.version ||
    JSON.stringify(declarations(manifest)) !== JSON.stringify(node.declarations)
  ) {
    fail("archive manifest does not match the validated registry graph")
  }
  const inspect = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      aborted(signal)
      if (++budget.files > 50000) fail("generation file limit exceeded")
      const filename = path.join(dir, entry.name)
      const stat = await lstat(filename)
      budget.bytes += stat.size
      if (budget.bytes > 512 * 1024 * 1024) fail("generation unpacked size limit exceeded")
      if (entry.isSymbolicLink() || entry.name === "node_modules")
        fail("archive contains unmanaged dependencies or links")
      if (entry.name.endsWith(".node") || entry.name === "binding.gyp")
        fail("native/build-required packages are unsupported")
      if (entry.isDirectory()) await inspect(path.join(dir, entry.name))
    }
  }
  await inspect(directory)
}

/** Validate the separately downloaded/extracted root before displaying an install preview. */
export async function validateNpmRoot(prepared: PreparedNpm, directory: string, signal?: AbortSignal): Promise<void> {
  if (!preparedTokens.has(prepared)) fail("unrecognized prepared graph; resolve it in this process first")
  aborted(signal)
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("root package must be a real directory")
  await verifyExtracted(directory, prepared.graph[0], { files: 0, bytes: 0 }, signal)
}

/** The directory is a private, empty generation container. The caller removes it on any failure. */
export async function materializeNpm(
  prepared: PreparedNpm,
  options: { directory: string; signal?: AbortSignal; download: NpmDownload; extract: NpmExtract },
): Promise<{ directory: string; lockDigest: string }> {
  if (!preparedTokens.has(prepared)) fail("unrecognized prepared graph; resolve it in this process first")
  aborted(options.signal)
  const directory = path.resolve(options.directory)
  // Do not follow an existing link at either the generation or its parent.
  if ((await realpath(path.dirname(directory))) !== path.dirname(directory))
    fail("generation parent contains a symlink")
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(directory)).length)
    fail("generation must be an empty directory")
  const budget = { files: 0, bytes: 0 }
  let downloaded = 0
  for (const node of prepared.graph) {
    aborted(options.signal)
    const input = await options.download({ url: node.tarball, integrity: node.integrity, signal: options.signal })
    downloaded += input.byteLength
    if (downloaded > 256 * 1024 * 1024) fail("generation download size limit exceeded")
    aborted(options.signal)
    const split = node.integrity.indexOf("-")
    const actual = createHash(node.integrity.slice(0, split)).update(input).digest("base64")
    if (actual !== node.integrity.slice(split + 1)) fail("tarball integrity mismatch")
    const destination = path.join(directory, node.directory)
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await options.extract(input, { directory: destination, signal: options.signal })
    await verifyExtracted(destination, node, budget, options.signal)
  }
  aborted(options.signal)
  await writeFile(path.join(directory, "npm-lock.json"), JSON.stringify({ lockVersion: 1, ...prepared }, null, 2), {
    flag: "wx",
    mode: 0o600,
  })
  return { directory: path.join(directory, "package"), lockDigest: prepared.lockDigest }
}
