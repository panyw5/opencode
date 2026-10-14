import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Shell } from "../../src/shell/shell"
import { Filesystem } from "@/util/filesystem"
import { which } from "../../src/util/which"

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

async function execute(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const proc = Bun.spawn([shell, ...Shell.args(shell, command, cwd)], {
    cwd: os.tmpdir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function shellFixture(shell: string, fn: (input: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-shell-test-"))
  const home = path.join(root, "home")
  const zdotdir = path.join(root, "z dotdir")
  const cwd = path.join(root, "work dir $'quoted")
  await Promise.all([fs.mkdir(home), fs.mkdir(zdotdir), fs.mkdir(cwd)])
  const rc = shell === "bash" ? path.join(home, ".bashrc") : path.join(zdotdir, ".zshrc")
  await fs.writeFile(rc, "set -- rc-mutated\nalias opencode_shell_test='printf alias-ok'\n")
  const env = { ...process.env, HOME: home, ZDOTDIR: zdotdir, OPENCODE_SHELL_MARKER: path.join(root, "executed") }
  try {
    await fn({ cwd, env })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("shell", () => {
  const posixShells = ["bash", "zsh"].flatMap((shell) => {
    const resolved = which(shell)
    return resolved ? [{ shell, resolved }] : []
  })

  for (const { shell, resolved } of posixShells) {
    test(`${shell} preserves the background PID expansion`, async () => {
      await shellFixture(shell, async ({ cwd, env }) => {
        const command =
          'sleep 30 & child=$!; kill -0 "$child"; printf "%s" "$child"; kill "$child"; wait "$child" 2>/dev/null || true'
        const result = await execute(resolved, command, cwd, env)
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toMatch(/^\d+$/)
      })
    })

    test(`${shell} preserves command text and safely executes it`, async () => {
      await shellFixture(shell, async ({ cwd, env }) => {
        const payload = "a\nb\tc\rd"
        const heredoc = "cat <<'OPENCODE_EOF'\nheredoc\n$HOME $(touch \"$OPENCODE_SHELL_MARKER\")\nOPENCODE_EOF"
        const literal = "printf '%s' '$HOME $(touch \"$OPENCODE_SHELL_MARKER\") `touch \"$OPENCODE_SHELL_MARKER\"`'"
        const command = [
          `printf '%s' '${payload}'`,
          heredoc,
          literal,
          "printf '%s' 'joined'\\\n",
          "printf '%s' 'slash\\\\ and quote \"kept\"'",
          "value='two words'; printf '<%s>' \"$value\"",
          "opencode_shell_test",
        ].join("\n")

        const result = await execute(resolved, command, cwd, env)
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(
          `${payload}heredoc\n$HOME $(touch \"$OPENCODE_SHELL_MARKER\")\n$HOME $(touch \"$OPENCODE_SHELL_MARKER\") \`touch \"$OPENCODE_SHELL_MARKER\"\`joinedslash\\\\ and quote "kept"<two words>alias-ok`,
        )
        expect(await fs.stat(env.OPENCODE_SHELL_MARKER!).catch(() => undefined)).toBeUndefined()
      })
    })

    test(`${shell} treats environment data as data`, async () => {
      await shellFixture(shell, async ({ cwd, env }) => {
        const marker = env.OPENCODE_SHELL_MARKER!
        const injected = `'; touch '${marker}'; #`
        const result = await execute(resolved, "printf '%s' \"$OPENCODE_SHELL_DATA\"", cwd, {
          ...env,
          OPENCODE_SHELL_DATA: injected,
        })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(injected)
        expect(await fs.stat(marker).catch(() => undefined)).toBeUndefined()
      })
    })

    test(`${shell} does not execute command after failing to change directory`, async () => {
      await shellFixture(shell, async ({ cwd, env }) => {
        const missing = path.join(cwd, "missing")
        const result = await execute(resolved, "printf SHOULD_NOT_RUN", missing, env)
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).toBe("")
      })
    })
  }

  test("rejects NUL bytes before selecting a shell argument form", () => {
    for (const shell of ["bash", "zsh", "fish", "pwsh", "cmd"]) {
      expect(() => Shell.args(shell, "before\0after", "/tmp")).toThrow("NUL byte")
    }
  })

  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = Shell.preferred()
      const acceptable = Shell.acceptable()
      expect(Shell.preferred("opencode-missing-shell")).toBe(preferred)
      expect(Shell.acceptable("opencode-missing-shell")).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", () => {
    expect(Shell.name(Shell.acceptable("fish"))).not.toBe("fish")
    expect(Shell.name(Shell.acceptable("nu"))).not.toBe("nu")
  })

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(Shell.acceptable())).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(Shell.preferred()).toBe(Filesystem.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      await withShell("/usr/bin/bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const bash = Shell.gitbash()
      if (!bash) return
      expect(Shell.acceptable("bash")).toBe(bash)
      expect(Shell.preferred("bash")).toBe(bash)
      await withShell("bash", async () => {
        expect(Shell.acceptable()).toBe(bash)
        expect(Shell.preferred()).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const shell = which("pwsh") || which("powershell")
      if (!shell) return
      await withShell(path.win32.basename(shell), async () => {
        expect(Shell.preferred()).toBe(shell)
      })
    })
  }
})
