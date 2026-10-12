import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createManifest, filenames, manifestName, type Contract, type Manifest } from "./desktop-artifacts"

const directories: string[] = []
const repo = "panyw5/opencode"
const commit = "a".repeat(40)
const version = "1.2.3"
const contracts: Contract[] = [
  { repo, commit, version, platform: "macos", arch: "x64", runId: "101", runAttempt: "1" },
  { repo, commit, version, platform: "macos", arch: "arm64", runId: "102", runAttempt: "2" },
  { repo, commit, version, platform: "windows", arch: "x64", runId: "103", runAttempt: "1" },
]
const workflows = ["build-macos-x64.yml", "build-macos-arm64.yml", "build-windows-desktop.yml"]
const sha512 = (text: string) => createHash("sha512").update(text).digest("base64")
type Run = {
  id: number
  run_attempt: number
  repository: { full_name: string }
  head_repository: { full_name: string }
  status: string
  conclusion: string
  event: string
  path: string
  head_sha: string
}
type Config = { runs: Record<string, Run>; release: boolean; tag: { object: { type: string; sha: string } } | null }
type Call = { args: string[]; assets?: string[]; provenance?: { commit: string; builds: unknown[] }; merged?: string }

// An executable on PATH, not a module mock: every subprocess command is recorded,
// and unknown commands fail closed so the tests cannot fall through to real gh.
const stub = `#!${process.execPath}
import { appendFile, cp, readFile } from "node:fs/promises"
import { join } from "node:path"
const args = process.argv.slice(2)
const root = process.env.RELEASE_TEST_ROOT
const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"))
const call = { args }
if (args[0] === "release" && args[1] === "create") {
  call.assets = args.filter(value => value.startsWith(join(root, "desktop-release", "assets") + "/"))
  for (const asset of call.assets) await readFile(asset)
  call.provenance = JSON.parse(await readFile(join(root, "desktop-release/assets/provenance.json"), "utf8"))
  call.merged = await readFile(join(root, "desktop-release/assets/latest-mac.yml"), "utf8")
}
await appendFile(join(root, "calls.jsonl"), JSON.stringify(call) + "\\n")
if (args[0] === "api") {
  const endpoint = args.at(-1)
  const run = endpoint.match(/^repos\\/panyw5\\/opencode\\/actions\\/runs\\/(\\d+)(.*)$/)
  if (run && config.runs[run[1]]) {
    if (!run[2]) console.log(JSON.stringify(config.runs[run[1]]))
    else if (run[2] === "/artifacts?per_page=100") {
      const names = { "101": "macos-x64", "102": "macos-arm64", "103": "windows-x64" }
      console.log(JSON.stringify([{ artifacts: [{ id: Number(run[1]) + 1000, name: "opencode-desktop-" + names[run[1]], expired: false }] }]))
    } else throw new Error("Unexpected run endpoint")
  } else if (endpoint === "repos/panyw5/opencode/releases/tags/v1.2.3" && config.release) console.log(JSON.stringify({ id: 99 }))
  else if (endpoint === "repos/panyw5/opencode/git/ref/tags/v1.2.3" && config.tag) console.log(JSON.stringify(config.tag))
  else if (["repos/panyw5/opencode/releases/tags/v1.2.3", "repos/panyw5/opencode/git/ref/tags/v1.2.3"].includes(endpoint)) {
    console.error("HTTP 404: Not Found")
    process.exit(1)
  } else throw new Error("Unexpected API endpoint: " + endpoint)
} else if (args[0] === "run" && args[1] === "download") {
  if (!config.runs[args[2]] || args[args.indexOf("--repo") + 1] !== "panyw5/opencode") throw new Error("Unexpected download")
  await cp(join(root, "fixtures", args[2]), args[args.indexOf("--dir") + 1], { recursive: true })
} else if (args[0] === "release" && args[1] === "create") {
  if (!args.includes("--draft")) throw new Error("Only drafts allowed")
  console.log("https://example.invalid/draft")
} else throw new Error("Unexpected gh command: " + args.join(" "))
`

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-release-test-")))
  directories.push(root)
  await mkdir(join(root, "bin"))
  await mkdir(join(root, "fixtures"))
  const config: Config = { runs: {}, release: false, tag: null }
  for (const [index, contract] of contracts.entries()) {
    const directory = join(root, "fixtures", contract.runId)
    await mkdir(directory)
    const names = filenames(contract)
    const binaries = names.slice(0, -1)
    for (const name of binaries) await writeFile(join(directory, name), name)
    const primary = binaries.find((name) => name.endsWith(".zip") || name.endsWith(".exe"))!
    await writeFile(
      join(directory, names.at(-1)!),
      JSON.stringify({
        version,
        files: binaries.map((name) => ({ url: name, sha512: sha512(name), size: Buffer.byteLength(name) })),
        path: primary,
        sha512: sha512(primary),
      }),
    )
    await createManifest(directory, contract)
    config.runs[contract.runId] = {
      id: Number(contract.runId),
      run_attempt: Number(contract.runAttempt),
      repository: { full_name: repo },
      head_repository: { full_name: repo },
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      path: `.github/workflows/${workflows[index]}`,
      head_sha: commit,
    }
  }
  await writeFile(join(root, "bin", "gh"), stub)
  await chmod(join(root, "bin", "gh"), 0o755)
  await writeFile(join(root, "calls.jsonl"), "")
  return { root, config }
}

async function execute(root: string, config: Config, artifactOnly = false) {
  await writeFile(join(root, "config.json"), JSON.stringify(config))
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "desktop-release.ts")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
      RELEASE_TEST_ROOT: root,
      GITHUB_REPOSITORY: repo,
      GITHUB_SHA: commit,
      RELEASE_VERSION: version,
      ARTIFACT_ONLY: String(artifactOnly),
      MACOS_X64_RUN_ID: "101",
      MACOS_ARM64_RUN_ID: "102",
      WINDOWS_RUN_ID: "103",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const calls: Call[] = (await readFile(join(root, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return { exit, output: stdout + stderr, calls }
}

function noRelease(calls: Call[]) {
  expect(calls.filter((call) => call.args[0] === "release")).toEqual([])
  expect(calls.some((call) => call.args.some((arg) => arg.includes("/releases/") || arg.includes("/git/")))).toBe(false)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("desktop release subprocess", () => {
  test("artifact_only verifies all three artifacts once and merges metadata without release operations", async () => {
    const { root, config } = await fixture()
    const result = await execute(root, config, true)
    expect(result.output).toContain("mode=artifact-only")
    expect(result.exit).toBe(0)
    noRelease(result.calls)
    expect(result.calls.filter((call) => call.args[0] === "run").map((call) => call.args.slice(0, 3))).toEqual([
      ["run", "download", "101"],
      ["run", "download", "102"],
      ["run", "download", "103"],
    ])
    const assets = join(root, "desktop-release", "assets")
    const merged = await readFile(join(assets, "latest-mac.yml"), "utf8")
    for (const contract of contracts.slice(0, 2))
      for (const name of filenames(contract).slice(0, -1)) {
        expect(merged).toContain(name)
        expect(merged).toContain(sha512(name))
      }
    const provenance = JSON.parse(await readFile(join(assets, "provenance.json"), "utf8"))
    expect(provenance).toMatchObject({
      repository: repo,
      commit,
      version,
      builds: contracts.map((contract) => ({ ...contract, artifactId: Number(contract.runId) + 1000 })),
    })
    expect((await readdir(assets)).sort()).toEqual(
      [...contracts.flatMap(filenames), "latest-mac.yml", "provenance.json"].sort(),
    )
  })

  test("creates a draft only after validations and merged assets are complete", async () => {
    const { root, config } = await fixture()
    config.tag = { object: { type: "commit", sha: commit } }
    const result = await execute(root, config)
    expect(result.exit).toBe(0)
    const release = result.calls.at(-1)!
    expect(release.args.slice(0, 3)).toEqual(["release", "create", `v${version}`])
    expect(release.args).toContain("--draft")
    expect(release.args).toContain("--verify-tag")
    expect(release.args[release.args.indexOf("--target") + 1]).toBe(commit)
    expect(release.provenance).toMatchObject({ commit, builds: contracts.map((contract) => ({ ...contract })) })
    expect(release.assets?.length).toBe(10)
    expect(release.merged).toContain("opencode-desktop-mac-arm64.zip")
    expect(result.calls.filter((call) => call.args[0] === "run").length).toBe(3)
    expect(result.output.indexOf("phase=create-draft")).toBeGreaterThan(
      result.output.indexOf("phase=merge-mac-updater"),
    )
  })

  test.each([
    ["SHA", "head_sha", "b".repeat(40), "GITHUB_SHA"],
    ["workflow", "path", ".github/workflows/other.yml", "workflow path"],
    ["conclusion", "conclusion", "failure", "completed successfully"],
    ["event", "event", "pull_request", "manually dispatched"],
  ])("rejects mismatched run %s before release", async (_label, key, value, error) => {
    const { root, config } = await fixture()
    Object.assign(config.runs["102"]!, { [key!]: value })
    const result = await execute(root, config)
    expect(result.exit).not.toBe(0)
    expect(result.output).toContain(error)
    noRelease(result.calls)
    expect(result.calls.filter((call) => call.args[0] === "run").length).toBe(1)
  })

  test.each(["repository", "head_repository"] as const)("rejects wrong run %s", async (key) => {
    const { root, config } = await fixture()
    config.runs["101"]![key].full_name = "other/opencode"
    const result = await execute(root, config)
    expect(result.exit).not.toBe(0)
    expect(result.output).toContain("Run repository mismatch")
    noRelease(result.calls)
  })

  test.each(["commit", "repo", "version", "arch", "runId", "runAttempt"] as const)(
    "rejects manifest %s mismatch before release",
    async (key) => {
      const { root, config } = await fixture()
      const contract = contracts[2]!
      const file = join(root, "fixtures", contract.runId, manifestName(contract))
      const manifest: Manifest = JSON.parse(await readFile(file, "utf8"))
      Object.assign(manifest, { [key]: "wrong" })
      await writeFile(file, JSON.stringify(manifest))
      const result = await execute(root, config)
      expect(result.exit).not.toBe(0)
      expect(result.output).toContain(`Manifest ${key} mismatch`)
      noRelease(result.calls)
    },
  )

  test("rejects corrupted artifact hash before release", async () => {
    const { root, config } = await fixture()
    await writeFile(join(root, "fixtures", "103", filenames(contracts[2]!)[0]!), "tampered binary")
    const result = await execute(root, config)
    expect(result.exit).not.toBe(0)
    expect(result.output).toContain("Manifest hash/size mismatch")
    noRelease(result.calls)
  })

  test("rejects existing releases rather than overwriting", async () => {
    const { root, config } = await fixture()
    config.release = true
    const result = await execute(root, config)
    expect(result.exit).not.toBe(0)
    expect(result.output).toContain("Release already exists")
    expect(result.calls.filter((call) => call.args[0] === "release")).toEqual([])
    expect(result.calls.at(-1)?.args).toEqual(["api", `repos/${repo}/releases/tags/v${version}`])
  })

  test("rejects an existing tag pointing at a different commit", async () => {
    const { root, config } = await fixture()
    config.tag = { object: { type: "commit", sha: "b".repeat(40) } }
    const result = await execute(root, config)
    expect(result.exit).not.toBe(0)
    expect(result.output).toContain("Existing tag does not point to the verified commit")
    expect(result.calls.filter((call) => call.args[0] === "release")).toEqual([])
  })
})
