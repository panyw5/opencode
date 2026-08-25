#!/usr/bin/env bun
/**
 * Parent that starts a detached math-worker then exits immediately.
 * Used by the Wave 2 probe: after this process is gone, the worker must still live.
 *
 * argv: <projectDir> <dbPath> <intervalMs>
 */
import path from "path"
import { spawnDetached } from "../../src/math/spawn"

if (import.meta.main) {
  const projectDir = process.argv[2]
  const dbPath = process.argv[3]
  const interval = process.argv[4] ?? "200"
  if (!projectDir || !dbPath) {
    process.stderr.write("usage: spawn-and-die.ts <projectDir> <dbPath> [intervalMs]\n")
    process.exit(2)
  }

  const mathRoot = path.join(projectDir, ".math", "default")
  const cliEntry = path.resolve(import.meta.dir, "../../src/index.ts")
  const result = spawnDetached({
    argv: [
      process.execPath,
      cliEntry,
      "math",
      "worker",
      "--create",
      "--project-dir",
      mathRoot,
      "--dir",
      projectDir,
      "--interval",
      interval,
      "--probe-heartbeat-only",
    ],
    cwd: projectDir,
    env: {
      OPENCODE_DB: dbPath,
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    },
    logFile: path.join(mathRoot, "logs", "worker-boot.log"),
  })
  process.stdout.write(JSON.stringify(result) + "\n")
}
