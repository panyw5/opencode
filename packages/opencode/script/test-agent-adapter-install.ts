import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-adapter-install-smoke-")))
for (const name of ["home", "data", "config", "cache", "state", "codex", "claude", "pi"])
  await fs.mkdir(path.join(root, name))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_CACHE_HOME = path.join(root, "cache")
process.env.XDG_STATE_HOME = path.join(root, "state")
process.env.OPENCODE_TEST_HOME = path.join(root, "home")
const { AgentInstallManager } = await import("../src/agent-backend/install")
const { AcpAgentClient } = await import("../src/agent-backend/acp-client")
const { Log } = await import("@opencode-ai/core/util/log")
await Log.init({ dev: true, print: true, level: "INFO" })
const manager = new AgentInstallManager(path.join(root, "managed"))
const selected = process.argv.slice(2)
try {
  for (const recipe of (await manager.status()).adapters) {
    if (selected.length && !selected.includes(recipe.advisor)) continue
    console.log(`[adapter-install-smoke] installing advisor=${recipe.advisor} version=${recipe.recommended}`)
    await manager.commit(
      manager.prepare({ advisor: recipe.advisor, version: recipe.recommended, action: "install" }).token,
      AbortSignal.timeout(300000),
    )
    const lease = await manager.acquire(recipe.advisor, recipe.recommended)
    const client = new AcpAgentClient({
      config: {
        type: "acp",
        command: lease.command as [string, ...string[]],
        env: {
          CODEX_HOME: path.join(root, "codex"),
          CLAUDE_CONFIG_DIR: path.join(root, "claude"),
          PI_CODING_AGENT_DIR: path.join(root, "pi"),
        },
      },
      cwd: path.join(root, "home"),
      onEvent: () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    })
    try {
      await client.start(AbortSignal.timeout(30000), { initializeOnly: true })
      console.log(
        `[adapter-install-smoke] PASS real package integrity and ACP handshake advisor=${recipe.advisor} authMethods=${client.authMethods.length}; no model prompt sent`,
      )
      await assert.rejects(
        manager.commit(
          manager.prepare({ advisor: recipe.advisor, version: recipe.recommended, action: "remove" }).token,
          AbortSignal.timeout(10000),
        ),
        /active session/,
      )
    } finally {
      await client.stop()
      await lease.release()
    }
    await manager.commit(
      manager.prepare({ advisor: recipe.advisor, version: recipe.recommended, action: "remove" }).token,
      AbortSignal.timeout(10000),
    )
    assert.equal((await manager.status()).adapters.find((item) => item.advisor === recipe.advisor)?.installed.length, 0)
    console.log(`[adapter-install-smoke] PASS removal advisor=${recipe.advisor}; global CLI untouched`)
  }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
