#!/usr/bin/env bun
/**
 * Parent that starts a detached math-worker then exits immediately.
 * Used by the Wave 2 probe: after this process is gone, the worker must still live.
 *
 * argv: <workspaceDir> <dbPath> <intervalMs>
 */
import path from "path"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { LocationLifecycle } from "../../src/project/location-lifecycle"
import { Session } from "../../src/session/session"
import { startMathWorker } from "../../src/math/worker"
import { spawnDetached } from "../../src/math/spawn"

if (import.meta.main) {
  const workspaceDir = process.argv[2]
  const dbPath = process.argv[3]
  const interval = process.argv[4] ?? "200"
  if (!workspaceDir || !dbPath) {
    process.stderr.write("usage: spawn-and-die.ts <workspaceDir> <dbPath> [intervalMs]\n")
    process.exit(2)
  }

  const setup = await AppRuntime.runPromise(
    LocationLifecycle.Service.use((lifecycle) =>
      lifecycle.provide(
        { directory: workspaceDir, purpose: "http-request" },
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ title: "detached probe", agent: "math-orchestrator" })
          const worker = yield* startMathWorker({
            parentSessionID: parent.id,
            title: "heartbeat probe",
            task: "Record heartbeat messages without running a model.",
            problem:
              "Let a and b be arbitrary even integers. By definition there are integers m and n with a = 2m and b = 2n. " +
              "Prove that a + b is even, identifying an integer witness for its divisibility by two. This isolated " +
              "problem is used to verify that a detached Math Mode worker can restart from its persisted session ID " +
              "after the parent process exits, without loading an external model or any reference files.",
            spawn: () => ({ pid: 987_654_321 }),
          })
          return { sessionID: worker.sessionID, projectDir: worker.projectDir }
        }),
      ),
    ),
  )
  const cliEntry = path.resolve(import.meta.dir, "../../src/index.ts")
  const result = spawnDetached({
    argv: [
      process.execPath,
      cliEntry,
      "math",
      "worker",
      "--session",
      setup.sessionID,
      "--generation",
      "1",
      "--interval",
      interval,
      "--probe-heartbeat-only",
    ],
    cwd: setup.projectDir,
    env: {
      OPENCODE_DB: dbPath,
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    },
    logFile: path.join(setup.projectDir, "logs", "worker-boot.log"),
  })
  process.stdout.write(JSON.stringify({ ...result, ...setup }) + "\n")
  process.exit(0)
}
