import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  AgentInstallManager,
  AgentInstallError,
  runPackageCommand,
  type PackageRunner,
} from "../../src/agent-backend/install"
import type { AdapterRecipe } from "../../src/agent-backend/catalog"
import { probeAdapter } from "../../src/agent-backend/probe"
import { tmpdir } from "../fixture/fixture"

const recipe: AdapterRecipe = {
  advisor: "claude",
  package: "fixture-adapter",
  entry: "dist/index.js",
  source: "https://example.test/reviewed",
  loginHelp: "Fixture login",
  requires: [],
  releases: [
    { version: "2.0.0", integrity: "sha512-fixture2" },
    { version: "1.0.0", integrity: "sha512-fixture1" },
  ],
}
const binaries = { node: process.execPath, npm: process.execPath }
const fixture = path.resolve(import.meta.dir, "../fixture/acp-agent.mjs")
function fakeRunner(calls: string[][], options: { integrity?: string } = {}): PackageRunner {
  return async (command, cwd, signal) => {
    calls.push(command)
    if (signal.aborted) throw new Error("cancelled")
    if (command.includes("--version")) return "v24.0.0"
    const version = command.at(-1)!.split("@").at(-1)!
    const release = recipe.releases.find((item) => item.version === version)!
    const module = path.join(cwd, "node_modules", recipe.package)
    await fs.mkdir(path.join(module, "dist"), { recursive: true })
    await fs.writeFile(
      path.join(module, "package.json"),
      JSON.stringify({ name: recipe.package, version, type: "module" }),
    )
    await fs.copyFile(fixture, path.join(module, recipe.entry))
    await fs.writeFile(
      path.join(cwd, "package-lock.json"),
      JSON.stringify({
        packages: {
          [`node_modules/${recipe.package}`]: { version, integrity: options.integrity ?? release.integrity },
        },
      }),
    )
    return "installed"
  }
}

describe("reviewed ACP installation store", () => {
  test("cancels an actual child process after its readiness marker without leaking it", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "ready")
    const abort = new AbortController()
    // Poll the published marker: macOS can coalesce create/write watcher events.
    const ready = async () => {
      const deadline = Date.now() + 5000
      while (!abort.signal.aborted && Date.now() < deadline) {
        const pid = await fs
          .readFile(marker, "utf8")
          .then(Number)
          .catch(() => 0)
        if (Number.isInteger(pid) && pid > 0) return pid
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error("Child never became ready")
    }
    const running = runPackageCommand(
      [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
        marker,
      ],
      tmp.path,
      abort.signal,
    )
    try {
      const pid = await Promise.race([
        ready(),
        running.then(() => {
          throw new Error("Child exited before cancellation")
        }),
      ])
      abort.abort()
      await expect(running).rejects.toThrow("cancelled")
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      abort.abort()
      await running.catch(() => {})
    }
  })
  test("inspection and preparation never install; confirmations are exact, one-use and isolated", async () => {
    await using tmp = await tmpdir()
    const calls: string[][] = []
    const manager = new AgentInstallManager(tmp.path, [recipe], fakeRunner(calls), binaries)
    const before = await manager.status()
    expect(before.adapters[0]?.installed).toEqual([])
    const prepared = manager.prepare({ advisor: "claude", version: "2.0.0", action: "install" })
    expect(calls).toHaveLength(0)
    expect(prepared.directory.startsWith(tmp.path)).toBe(true)
    expect(prepared.integrity).toBe("sha512-fixture2")
    const after = await manager.commit(prepared.token, AbortSignal.timeout(5000))
    expect(after.adapters[0]?.installed.map((item) => item.version)).toEqual(["2.0.0"])
    expect(calls[1]).toContain("--ignore-scripts")
    expect(calls[1]).toContain("--save-exact")
    expect(calls[1]).toContain("fixture-adapter@2.0.0")
    expect(calls[1]).not.toContain("-g")
    await expect(manager.commit(prepared.token, AbortSignal.timeout(5000))).rejects.toThrow("already used")
    expect(() => manager.prepare({ advisor: "claude", version: "../../victim", action: "remove" })).toThrow()
    expect(() => manager.prepare({ advisor: "codex", version: "2.0.0", action: "install" })).toThrow()
  })

  test("retains older releases for rollback, refuses removal while leased, and probes the managed executable", async () => {
    await using tmp = await tmpdir()
    const manager = new AgentInstallManager(tmp.path, [recipe], fakeRunner([]), binaries)
    for (const version of ["1.0.0", "2.0.0"])
      await manager.commit(
        manager.prepare({ advisor: "claude", version, action: "install" }).token,
        AbortSignal.timeout(5000),
      )
    expect((await manager.status()).adapters[0]?.installed).toHaveLength(2)
    const lease = await manager.acquire("claude", "1.0.0")
    await expect(
      manager.commit(
        manager.prepare({ advisor: "claude", version: "1.0.0", action: "remove" }).token,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("active session")
    await lease.release()
    const result = await probeAdapter(
      {
        advisor: "claude",
        config: { type: "acp", command: ["must-not-run"], managed: { advisor: "claude", version: "1.0.0" } },
        cwd: tmp.path,
        signal: AbortSignal.timeout(5000),
        message: true,
      },
      manager,
    )
    expect(result.status).toBe("ready")
    expect(result.response).toContain("ACP_REPLY_1")
    await manager.commit(
      manager.prepare({ advisor: "claude", version: "2.0.0", action: "remove" }).token,
      AbortSignal.timeout(5000),
    )
    expect((await manager.status()).adapters[0]?.installed.map((item) => item.version)).toEqual(["1.0.0"])
  })
  test("installed status remains visible when Node is missing, but execution is refused", async () => {
    await using tmp = await tmpdir()
    const manager = new AgentInstallManager(tmp.path, [recipe], fakeRunner([]), binaries)
    await manager.commit(
      manager.prepare({ advisor: "claude", version: "2.0.0", action: "install" }).token,
      AbortSignal.timeout(5000),
    )
    const missing = new AgentInstallManager(tmp.path, [recipe], fakeRunner([]), { node: undefined, npm: undefined })
    const status = await missing.status()
    expect(status.node).toBeNull()
    expect(status.adapters[0]?.installed).toHaveLength(1)
    await expect(missing.acquire("claude", "2.0.0")).rejects.toThrow("Node.js")
    await missing.commit(
      missing.prepare({ advisor: "claude", version: "2.0.0", action: "remove" }).token,
      AbortSignal.timeout(5000),
    )
    expect((await missing.status()).adapters[0]?.installed).toEqual([])
  })

  test("integrity failure preserves existing installations and removes staging files", async () => {
    await using tmp = await tmpdir()
    const good = new AgentInstallManager(tmp.path, [recipe], fakeRunner([]), binaries)
    await good.commit(
      good.prepare({ advisor: "claude", version: "1.0.0", action: "install" }).token,
      AbortSignal.timeout(5000),
    )
    const bad = new AgentInstallManager(tmp.path, [recipe], fakeRunner([], { integrity: "sha512-wrong" }), binaries)
    await expect(
      bad.commit(
        bad.prepare({ advisor: "claude", version: "2.0.0", action: "install" }).token,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toBeInstanceOf(AgentInstallError)
    expect(await fs.readdir(path.join(tmp.path, "staging"))).toEqual([])
    expect((await good.status()).adapters[0]?.installed.map((item) => item.version)).toEqual(["1.0.0"])
  })

  test("package-manager failure and cancellation release locks without publishing partial versions", async () => {
    await using tmp = await tmpdir()
    const failing = new AgentInstallManager(
      tmp.path,
      [recipe],
      async (args) => {
        if (args.includes("--version")) return "v24.0.0"
        throw new Error("registry unavailable")
      },
      binaries,
    )
    await expect(
      failing.commit(
        failing.prepare({ advisor: "claude", version: "2.0.0", action: "install" }).token,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("registry unavailable")
    expect(await fs.readdir(path.join(tmp.path, "locks"))).toEqual([])
    expect((await failing.status()).adapters[0]?.installed).toEqual([])
    const abort = new AbortController()
    abort.abort()
    const cancelled = new AgentInstallManager(tmp.path, [recipe], fakeRunner([]), binaries)
    await expect(
      cancelled.commit(
        cancelled.prepare({ advisor: "claude", version: "2.0.0", action: "install" }).token,
        abort.signal,
      ),
    ).rejects.toThrow()
    expect((await cancelled.status()).adapters[0]?.installed).toEqual([])
  })

  test("two manager instances coordinate through the filesystem lock", async () => {
    await using tmp = await tmpdir()
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let proceed!: () => void
    const gate = new Promise<void>((resolve) => {
      proceed = resolve
    })
    const first = new AgentInstallManager(
      tmp.path,
      [recipe],
      async (args, cwd, signal) => {
        if (!args.includes("--version")) {
          started()
          await gate
        }
        return fakeRunner([])(args, cwd, signal)
      },
      binaries,
    )
    const second = new AgentInstallManager(tmp.path, [recipe], fakeRunner([]), binaries)
    const operation = first.commit(
      first.prepare({ advisor: "claude", version: "2.0.0", action: "install" }).token,
      AbortSignal.timeout(5000),
    )
    await ready
    try {
      await expect(
        second.commit(
          second.prepare({ advisor: "claude", version: "2.0.0", action: "install" }).token,
          AbortSignal.timeout(5000),
        ),
      ).rejects.toThrow("Another adapter operation")
    } finally {
      proceed()
      await operation
    }
  })
})
