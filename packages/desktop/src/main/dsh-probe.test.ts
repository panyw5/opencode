import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listDshProfiles, testDshConfig } from "./dsh-status"

test("DSH profile choices include installed custom profiles and exclude server profiles", async () => {
  const home = await mkdtemp(join(tmpdir(), "opencode-dsh-profiles-test-"))
  try {
    expect(await listDshProfiles(home)).toEqual(["headless"])
    for (const name of [
      "review",
      "headless",
      "implementation",
      "web",
      "desktop",
      "sdk",
      "sdk-minimal",
      "acp",
      "node_modules",
      "bad name",
    ]) {
      await mkdir(join(home, "profiles", name), { recursive: true })
    }
    await writeFile(join(home, "profiles", "not-a-profile"), "")
    expect(await listDshProfiles(home)).toEqual(["headless", "implementation", "review"])
    await rm(join(home, "profiles"), { recursive: true })
    await writeFile(join(home, "profiles"), "not a directory")
    await expect(listDshProfiles(home)).rejects.toThrow()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "DSH connection test validates requested permission flags against installed profile help",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-dsh-probe-test-"))
    const binaryPath = join(directory, "dsh")
    const config = {
      enabled: true,
      binaryPath,
      configHome: directory,
      defaults: {
        profile: "review",
        permission_mode: "read-only",
        approval_policy: "never" as const,
        patch: ["[]"],
        additional_writable_roots: [directory],
      },
    }
    const writeCli = async (help: string) => {
      await writeFile(
        binaryPath,
        `#!/usr/bin/env node\nconsole.log(process.argv.includes('--help') ? ${JSON.stringify(help)} : '1.0.0');\n`,
      )
      await chmod(binaryPath, 0o700)
    }
    try {
      await writeCli("Usage: dsh [task]")
      const unsupported = await testDshConfig(config)
      expect(unsupported.ok).toBe(false)
      expect(unsupported.logs.join("\n")).toContain("--permission-mode")
      await writeCli("--permission-mode <preset> --approval-policy <policy> --add-dir <path>")
      const supported = await testDshConfig(config)
      expect(supported.ok).toBe(true)
      expect(supported.logs.join("\n")).toContain("Checking profile: review; patches: 1")
      expect((await testDshConfig({ ...config, defaults: { working_directory: "relative" } })).ok).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
