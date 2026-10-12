#!/usr/bin/env bun

import { copyFile, lstat, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import semver from "semver"
import { verifyManifest, mergeMacMetadata, type Contract, type Manifest } from "./desktop-artifacts"

// Shared helper integration contract: verification must include updater YAML,
// exact expected filenames, hash/size checks, and rejection of extra files.
type ArtifactExpectation = Contract & { directory: string }
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

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function gh(args: string[], optional = false): Promise<string | undefined> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, error, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (optional && exit !== 0 && /HTTP 404/.test(error)) return undefined
  assert(exit === 0, `gh ${args.slice(0, 2).join(" ")} failed: ${error.trim()}`)
  return out
}

async function api<T>(endpoint: string): Promise<T> {
  // GitHub's authenticated REST schema is checked by each caller before use.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse((await gh(["api", endpoint]))!) as unknown as T
}

function basename(name: string) {
  assert(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) && name !== "." && name !== "..", `Unsafe filename: ${name}`)
  return name
}

async function main() {
  const repository = "panyw5/opencode"
  assert(process.env.GITHUB_REPOSITORY === repository, "Release preparation is restricted to panyw5/opencode")
  const commit = process.env.GITHUB_SHA ?? ""
  assert(/^[a-f0-9]{40}$/.test(commit), "Missing/invalid GITHUB_SHA")
  const version = (process.env.RELEASE_VERSION ?? "").trim().replace(/^v(?=\d)/, "")
  assert(semver.valid(version) === version, "Release version must be valid semver")
  assert(["true", "false"].includes(process.env.ARTIFACT_ONLY ?? ""), "ARTIFACT_ONLY must be true or false")
  const sources = [
    { platform: "macos", arch: "x64", id: process.env.MACOS_X64_RUN_ID, workflow: "build-macos-x64.yml" },
    { platform: "macos", arch: "arm64", id: process.env.MACOS_ARM64_RUN_ID, workflow: "build-macos-arm64.yml" },
    { platform: "windows", arch: "x64", id: process.env.WINDOWS_RUN_ID, workflow: "build-windows-desktop.yml" },
  ] as const
  for (const source of sources) assert(source.id && /^[1-9]\d*$/.test(source.id), `Invalid ${source.arch} run ID`)
  assert(new Set(sources.map((source) => source.id)).size === 3, "Build run IDs must be distinct")

  const root = path.resolve("desktop-release")
  assert(!(await Bun.file(path.join(root, "provenance.json")).exists()), "Release staging already exists")
  await mkdir(root) // Fail closed on any existing staging directory.
  const output = path.join(root, "assets")
  await mkdir(output)
  const verified: { expected: ArtifactExpectation; manifest: Manifest; artifactId: number }[] = []
  for (const source of sources) {
    console.log(`desktop-release phase=run-validation platform=${source.platform} arch=${source.arch} run=${source.id}`)
    const run = await api<Run>(`repos/${repository}/actions/runs/${source.id}`)
    assert(String(run.id) === source.id, "Run ID mismatch")
    assert(
      run.repository.full_name === repository && run.head_repository.full_name === repository,
      "Run repository mismatch",
    )
    assert(run.status === "completed" && run.conclusion === "success", "Build run must have completed successfully")
    assert(run.event === "workflow_dispatch", "Build must be manually dispatched")
    assert(run.path === `.github/workflows/${source.workflow}`, "Unexpected build workflow path")
    assert(run.head_sha === commit, "All builds must match release workflow GITHUB_SHA")
    assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, "Invalid run attempt")
    const artifactName = `opencode-desktop-${source.platform}-${source.arch}`
    const artifacts = await gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/actions/runs/${source.id}/artifacts?per_page=100`,
    ])
    // GitHub REST pagination wraps the documented artifacts response in pages.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const matches = (
      JSON.parse(artifacts!) as unknown as { artifacts: { id: number; name: string; expired: boolean }[] }[]
    )
      .flatMap((page) => page.artifacts)
      .filter((artifact) => artifact.name === artifactName)
    assert(matches.length === 1 && !matches[0]!.expired, `Missing, ambiguous or expired artifact: ${artifactName}`)
    const directory = path.join(root, `${source.platform}-${source.arch}`)
    await mkdir(directory)
    console.log(`desktop-release phase=download artifact=${artifactName} id=${matches[0]!.id}`)
    await gh(["run", "download", source.id, "--repo", repository, "--name", artifactName, "--dir", directory])
    const contract: Contract = {
      repo: repository,
      commit,
      version,
      platform: source.platform,
      arch: source.arch,
      runId: source.id,
      runAttempt: String(run.run_attempt),
    }
    const expected: ArtifactExpectation = { ...contract, directory }
    console.log(`desktop-release phase=updater-validation platform=${source.platform} arch=${source.arch}`)
    const manifest = await verifyManifest(directory, contract)
    verified.push({ expected, manifest, artifactId: matches[0]!.id })
  }

  const copied = new Set<string>()
  for (const item of verified) {
    for (const file of item.manifest.files) {
      if (file.basename === "latest-mac.yml") continue
      assert(!copied.has(file.basename), `Release asset collision: ${file.basename}`)
      copied.add(file.basename)
      await copyFile(path.join(item.expected.directory, file.basename), path.join(output, file.basename))
    }
  }
  console.log("desktop-release phase=merge-mac-updater")
  const { directory: x64Directory, ...x64Contract } = verified[0]!.expected
  const { directory: arm64Directory, ...arm64Contract } = verified[1]!.expected
  await mergeMacMetadata(x64Directory, arm64Directory, output, x64Contract, arm64Contract)
  const provenance = {
    schemaVersion: 1,
    repository,
    commit,
    version,
    builds: verified.map(({ expected, artifactId }) => ({ ...expected, directory: undefined, artifactId })),
  }
  await Bun.write(path.join(output, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n")
  const assets = await readdir(output)
  assert(assets.includes("latest-mac.yml"), "Shared helper did not produce merged latest-mac.yml")
  assert(
    assets.length === copied.size + 2 &&
      assets.every((name) => copied.has(name) || ["latest-mac.yml", "provenance.json"].includes(name)),
    "Unexpected merged assets",
  )
  for (const asset of assets)
    assert((await lstat(path.join(output, basename(asset)))).isFile(), "Release assets must be flat files")
  if (process.env.ARTIFACT_ONLY === "true") {
    console.log("desktop-release phase=complete mode=artifact-only; no release or tag changes")
    return
  }

  const tag = `v${version}`
  assert(
    !(await gh(["api", `repos/${repository}/releases/tags/${tag}`], true)),
    "Release already exists; refusing to overwrite or publish",
  )
  const existing = await gh(["api", `repos/${repository}/git/ref/tags/${tag}`], true)
  if (existing) {
    // The resolved object type and exact commit are checked below.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    let object = (JSON.parse(existing) as unknown as { object: { type: string; sha: string } }).object
    const seen = new Set<string>()
    while (object.type === "tag") {
      assert(!seen.has(object.sha), "Tag cycle")
      seen.add(object.sha)
      object = (await api<{ object: typeof object }>(`repos/${repository}/git/tags/${object.sha}`)).object
    }
    assert(object.type === "commit" && object.sha === commit, "Existing tag does not point to the verified commit")
  }
  console.log(`desktop-release phase=create-draft tag=${tag} commit=${commit}`)
  await gh([
    "release",
    "create",
    tag,
    "--repo",
    repository,
    "--draft",
    "--target",
    commit,
    ...(existing ? ["--verify-tag"] : []),
    "--title",
    `OpenCode ${tag}`,
    "--notes",
    `Desktop builds verified against ${commit}. See provenance.json for source runs.`,
    ...assets.map((asset) => path.join(output, asset)),
  ])
  console.log("desktop-release phase=complete mode=draft; never published")
}

if (import.meta.main) await main()
