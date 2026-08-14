import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { buildDshExecArgs } from "../../src/tool/dsh_consult"
import { which } from "../../src/util/which"

const hasDsh = !!which("dsh")
const profilesNodeModules = path.join(homedir(), ".dsh", "profiles", "node_modules")

const PATCH = [
  "- id: llm-deepseek",
  "  config:",
  "    thinking: disabled",
  "    models:",
  "      - id: deepseek-v4-pro",
  "        contextWindow: 128000",
  "",
].join("\n")

function runDsh(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("dsh", args, { cwd: tmpdir(), env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout, stderr, code }))
  })
}

function runDshWithHome(
  dshHome: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("dsh", args, { cwd: tmpdir(), env: { ...process.env, DSH_HOME: dshHome } })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout, stderr, code }))
  })
}

describe("tool.dsh_consult dynamic config against the real dsh binary", () => {
  test.skipIf(!hasDsh)("profile + patch argv is accepted and the patch applies at boot", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-patch-test-"))
    try {
      const patchFile = path.join(dir, "patch.yml")
      await writeFile(patchFile, PATCH)

      // The exact argv shape the tool builds for a consult: launcher flags first.
      const consultArgs = buildDshExecArgs({ prompt: "hi", patch: [patchFile] })
      expect(consultArgs[0]).toBe("--profile")
      expect(consultArgs[1]).toBe("headless")
      expect(consultArgs.slice(2, 4)).toEqual(["--patch", patchFile])

      // Boot-free verification: same launcher flag family with --dump-config.
      const patched = await runDsh(["--profile", "headless", "--patch", patchFile, "--dump-config"])
      expect(patched.code).toBe(0)
      expect(patched.stdout).toContain("thinking: disabled")
      expect(patched.stdout).toContain("- id: deepseek-v4-pro")

      // Control: without the patch the override must not be present.
      const plain = await runDsh(["--profile", "headless", "--dump-config"])
      expect(plain.code).toBe(0)
      expect(plain.stdout).not.toContain("thinking: disabled")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(!hasDsh)("multiple patches layer in order with the last one winning", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-patch-test-"))
    try {
      const first = path.join(dir, "first.yml")
      const second = path.join(dir, "second.yml")
      await writeFile(
        first,
        [
          "- id: llm-deepseek",
          "  config:",
          "    thinking: enabled",
          "    reasoningEffort: low",
          "",
        ].join("\n"),
      )
      await writeFile(
        second,
        [
          "- id: llm-deepseek",
          "  config:",
          "    thinking: disabled",
          "",
        ].join("\n"),
      )

      const args = buildDshExecArgs({ prompt: "hi", patch: [first, second] })
      expect(args.slice(2, 6)).toEqual(["--patch", first, "--patch", second])

      const out = await runDsh([
        "--profile",
        "headless",
        "--patch",
        first,
        "--patch",
        second,
        "--dump-config",
      ])
      expect(out.code).toBe(0)
      expect(out.stdout).toContain("thinking: disabled")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(!hasDsh || !existsSync(profilesNodeModules))(
    "profile parameter boots a custom profile whose own patch layer applies",
    async () => {
      const dshHome = await mkdtemp(path.join(tmpdir(), "dsh-home-test-"))
      try {
        const profileDir = path.join(dshHome, "profiles", "review")
        await mkdir(profileDir, { recursive: true })
        await writeFile(
          path.join(profileDir, "package.json"),
          JSON.stringify(
            {
              name: "dsh-profile-review",
              private: true,
              dependencies: {},
              dsh: {
                profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] },
              },
            },
            null,
            2,
          ),
        )
        await writeFile(path.join(profileDir, "cordis.yml"), "[]\n")
        await writeFile(
          path.join(profileDir, "cordis.patch.yml"),
          [
            "- id: llm-deepseek",
            "  config:",
            "    thinking: disabled",
            "    reasoningEffort: low",
            "    models:",
            "      - id: deepseek-v4-pro",
            "        contextWindow: 128000",
            "",
          ].join("\n"),
        )
        // Bundle modules resolve through the shared profiles/node_modules tree.
        await symlink(profilesNodeModules, path.join(dshHome, "profiles", "node_modules"))

        const out = await runDshWithHome(dshHome, ["--profile", "review", "--dump-config"])
        expect(out.code).toBe(0)
        expect(out.stdout).toContain("thinking: disabled")
        expect(out.stdout).toContain("reasoningEffort: low")
        expect(out.stdout).toContain("- id: deepseek-v4-pro")
      } finally {
        await rm(dshHome, { recursive: true, force: true })
      }
    },
  )
})
