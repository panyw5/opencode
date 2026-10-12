import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createManifest,
  filenames,
  main,
  manifestName,
  mergeMacMetadata,
  verifyManifest,
  type Contract,
} from "./desktop-artifacts"

const directories: string[] = []
const base: Contract = {
  repo: "panyw5/opencode",
  commit: "a".repeat(40),
  version: "1.2.3",
  platform: "macos",
  arch: "x64",
  runId: "123",
  runAttempt: "1",
}
const sha512 = (text: string) => createHash("sha512").update(text).digest("base64")

async function fixture(contract = base, old = false) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-artifacts-"))
  directories.push(directory)
  const names = filenames(contract)
  for (const name of names.slice(0, -1)) await writeFile(join(directory, name), name)
  const binaries = names.slice(0, -1)
  const primary = binaries.find((name) => name.endsWith(".zip") || name.endsWith(".exe"))!
  const files = binaries.map((name) => ({
    url: old && name.endsWith(".dmg") ? `opencode-desktop-mac-${contract.arch}.dmg` : name,
    sha512: sha512(old && name.endsWith(".dmg") ? "before stapling" : name),
    size: old && name.endsWith(".dmg") ? 15 : name.length,
  }))
  await writeFile(
    join(directory, names.at(-1)!),
    JSON.stringify({ version: contract.version, files, path: primary, sha512: sha512(primary) }),
  )
  return directory
}

async function mutate(directory: string, name: string, change: (value: any) => void) {
  const path = join(directory, name)
  const value = JSON.parse(await readFile(path, "utf8"))
  change(value)
  await writeFile(path, JSON.stringify(value))
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("desktop artifacts", () => {
  test("creates and verifies final stapled mac hashes and mapped builder names", async () => {
    const directory = await fixture(base, true)
    const manifest = await createManifest(directory, base)
    expect(manifest.files.map((file) => file.basename)).toEqual(filenames(base))
    expect(await verifyManifest(directory, base)).toEqual(manifest)
    const text = await readFile(join(directory, "latest-mac-x64.yml"), "utf8")
    expect(text).toContain("OpenCode_1.2.3_x64.dmg")
    expect(text).toContain(sha512("OpenCode_1.2.3_x64.dmg"))
  })

  test("Windows validates installer and top-level metadata", async () => {
    const contract: Contract = { ...base, platform: "windows" }
    const directory = await fixture(contract)
    await createManifest(directory, contract)
    await verifyManifest(directory, contract)
    await mutate(directory, "latest.yml", (value) => {
      value.sha512 = sha512("wrong")
    })
    await expect(createManifest(directory, contract)).rejects.toThrow("top-level")
  })

  test("accepts builder 26.8.1 YAML with blockMapSize, ZIP top path and releaseDate", async () => {
    const directory = await fixture(base, true)
    const zip = "opencode-desktop-mac-x64.zip"
    // updateInfoBuilder.writeUpdateInfoFiles orders ZIP before DMG and retains ZIP path/hash.
    const text = `version: 1.2.3
files:
  - url: ${zip}
    sha512: ${sha512(zip)}
    size: ${zip.length}
    blockMapSize: 1234
  - url: opencode-desktop-mac-x64.dmg
    sha512: ${sha512("before stapling")}
    size: 15
    blockMapSize: 5678
path: ${zip}
sha512: ${sha512(zip)}
releaseDate: '2026-10-12T12:00:00.000Z'
`
    await writeFile(join(directory, "latest-mac-x64.yml"), text)
    await createManifest(directory, base)
    await verifyManifest(directory, base)
    expect(await readFile(join(directory, "latest-mac-x64.yml"), "utf8")).not.toContain("blockMapSize")
  })

  test.each([0, -1, 1.5, "123", null])("rejects invalid builder blockMapSize %j", async (blockMapSize) => {
    const directory = await fixture()
    await mutate(directory, "latest-mac-x64.yml", (value) => {
      value.files[0].blockMapSize = blockMapSize
    })
    await expect(createManifest(directory, base)).rejects.toThrow("blockMapSize")
  })

  test("accepts Windows builder blockMapSize and releaseDate", async () => {
    const contract: Contract = { ...base, platform: "windows" }
    const directory = await fixture(contract)
    await mutate(directory, "latest.yml", (value) => {
      value.files[0].blockMapSize = 1234
      value.releaseDate = "2026-10-12T12:00:00.000Z"
    })
    await createManifest(directory, contract)
    await verifyManifest(directory, contract)
  })

  test.each(["repo", "commit", "version", "arch", "runId", "runAttempt"] as const)(
    "rejects mismatched expected %s",
    async (field) => {
      const directory = await fixture()
      await createManifest(directory, base)
      await mutate(directory, manifestName(base), (value) => {
        value[field] = "wrong"
      })
      await expect(verifyManifest(directory, base)).rejects.toThrow(`${field} mismatch`)
    },
  )

  test.each([
    { commit: "invalid" },
    { version: "v1.2.3" },
    { arch: "aarch64" },
    { repo: "https://evil.test/repo" },
    { runId: "0" },
    { runAttempt: "-1" },
    { platform: "windows", arch: "arm64" },
  ])("rejects invalid contract %j", async (override) => {
    expect(() => filenames({ ...base, ...override } as Contract)).toThrow()
  })

  test.each(["../escape.zip", "https://evil.test/file.zip", "/absolute.zip", "file%2fescape.zip", "file\\escape.zip"])(
    "rejects metadata URL %s",
    async (url) => {
      const directory = await fixture()
      await mutate(directory, "latest-mac-x64.yml", (value) => {
        value.files[0].url = url
      })
      await expect(createManifest(directory, base)).rejects.toThrow("Unsafe filename")
    },
  )

  test.each(["version", "hash", "size", "duplicate", "missing", "arch", "top-path"])(
    "rejects bad metadata %s",
    async (kind) => {
      const directory = await fixture()
      await mutate(directory, "latest-mac-x64.yml", (value) => {
        if (kind === "version") value.version = "9.9.9"
        if (kind === "hash") value.files[1].sha512 = sha512("bad")
        if (kind === "size") value.files[1].size++
        if (kind === "duplicate") value.files[1] = value.files[0]
        if (kind === "missing") value.files.pop()
        if (kind === "arch") value.files[1].url = "opencode-desktop-mac-arm64.zip"
        if (kind === "top-path") value.path = "https://evil.test/update.zip"
      })
      await expect(createManifest(directory, base)).rejects.toThrow()
    },
  )

  test.each(["hash", "size", "duplicate", "traversal", "missing", "schema"])(
    "rejects bad manifest %s",
    async (kind) => {
      const directory = await fixture()
      await createManifest(directory, base)
      await mutate(directory, manifestName(base), (value) => {
        if (kind === "hash") value.files[0].sha512 = sha512("bad")
        if (kind === "size") value.files[0].size++
        if (kind === "duplicate") value.files[1] = value.files[0]
        if (kind === "traversal") value.files[0].basename = "../escape"
        if (kind === "missing") value.files.pop()
        if (kind === "schema") value.schemaVersion = 2
      })
      await expect(verifyManifest(directory, base)).rejects.toThrow()
    },
  )

  test.each(["symlink", "missing", "unexpected", "blockmap"])("rejects directory policy violation %s", async (kind) => {
    const directory = await fixture()
    await createManifest(directory, base)
    const name = filenames(base)[0]!
    if (kind === "missing" || kind === "symlink") await rm(join(directory, name))
    if (kind === "symlink") await symlink(join(directory, filenames(base)[1]!), join(directory, name))
    if (kind === "unexpected") await writeFile(join(directory, "unexpected.txt"), "bad")
    if (kind === "blockmap") await writeFile(join(directory, `${name}.blockmap`), "bad")
    await expect(verifyManifest(directory, base)).rejects.toThrow()
  })

  test("verify validates metadata even after manifest metadata hash is updated", async () => {
    const directory = await fixture()
    await createManifest(directory, base)
    await writeFile(join(directory, "latest-mac-x64.yml"), JSON.stringify({ version: "9.9.9" }))
    const bytes = await readFile(join(directory, "latest-mac-x64.yml"))
    await mutate(directory, manifestName(base), (value) => {
      const file = value.files.find((file: any) => file.basename.endsWith(".yml"))
      file.size = bytes.length
      file.sha512 = createHash("sha512").update(bytes).digest("base64")
    })
    await expect(verifyManifest(directory, base)).rejects.toThrow("Metadata version")
  })

  test("rejects duplicate YAML keys and a symlinked manifest or directory", async () => {
    const duplicate = await fixture()
    await writeFile(join(duplicate, "latest-mac-x64.yml"), "version: 1.2.3\nversion: 9.9.9\n")
    await expect(createManifest(duplicate, base)).rejects.toThrow("duplicated mapping key")
    const directory = await fixture()
    await createManifest(directory, base)
    const target = join(directory, manifestName(base))
    await rm(target)
    await symlink(join(directory, "latest-mac-x64.yml"), target)
    await expect(verifyManifest(directory, base)).rejects.toThrow("Not a regular file")
    const link = `${directory}-link`
    directories.push(link)
    await symlink(directory, link)
    await expect(verifyManifest(link, base)).rejects.toThrow("Unsafe directory")
  })

  test("merges both verified architectures deterministically with arm64 ZIP token", async () => {
    const arm: Contract = { ...base, arch: "arm64", runId: "456", runAttempt: "2" }
    const x64Directory = await fixture()
    const arm64Directory = await fixture(arm)
    await createManifest(x64Directory, base)
    await createManifest(arm64Directory, arm)
    const output = await mkdtemp(join(tmpdir(), "desktop-merge-"))
    directories.push(output)
    const path = await mergeMacMetadata(x64Directory, arm64Directory, output, base, arm)
    const text = await readFile(path, "utf8")
    expect(text.match(/  - url:/g)).toHaveLength(4)
    expect(text).toContain("opencode-desktop-mac-arm64.zip")
    expect(text).toContain("OpenCode_1.2.3_aarch64.dmg")
    await mergeMacMetadata(x64Directory, arm64Directory, output, base, arm)
    expect(await readFile(path, "utf8")).toBe(text)
    await expect(
      mergeMacMetadata(x64Directory, arm64Directory, output, base, { ...arm, commit: "b".repeat(40) }),
    ).rejects.toThrow("Merge commit")
    await writeFile(join(arm64Directory, filenames(arm)[0]!), "tampered")
    await expect(mergeMacMetadata(x64Directory, arm64Directory, output, base, arm)).rejects.toThrow("hash/size")
  })

  test("CLI create and verify consume env provenance and explicit verification overrides", async () => {
    const directory = await fixture()
    const env = {
      OPENCODE_VERSION: base.version,
      GITHUB_REPOSITORY: base.repo,
      GITHUB_SHA: base.commit,
      GITHUB_RUN_ID: base.runId,
      GITHUB_RUN_ATTEMPT: base.runAttempt,
    }
    const args = ["--platform", "macos", "--arch", "x64", "--directory", directory]
    await main(["create", ...args], env)
    await main(["verify", ...args, "--run-id", base.runId], { ...env, GITHUB_RUN_ID: "999" })
    await expect(main(["verify", ...args], { ...env, GITHUB_SHA: "b".repeat(40) })).rejects.toThrow("commit mismatch")
    await expect(main(["verify", ...args, "--unknown", "value"], env)).rejects.toThrow("Unknown option")
  })
})
