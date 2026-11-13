import { Schema } from "effect"
import { RuntimeIdentity } from "../../../../src/extension/host-process/protocol.ts"
import { openWorkerChannel, serveWorker } from "../../../../src/extension/host-process/worker.ts"
import { loadExtensionApplication } from "../../../../src/extension/host-process/application.ts"

/**
 * Thin worker-process driver for the T5.2 tests: identical wiring to the
 * `opencode extension-host` entrypoint minus argv parsing (covered by the
 * CLI smoke test). Runs under both Bun and Node type-stripping.
 */
const identity = Schema.decodeUnknownSync(RuntimeIdentity)(JSON.parse(process.argv[2]))
const channel = openWorkerChannel({ frameBytes: 1024 * 1024 })
const outcome = await serveWorker({
  identity,
  channel,
  maxRequests: 8,
  load: (init, host, signal) => loadExtensionApplication(init, host, signal),
  report: (event) => process.stderr.write(`${event}\n`),
  disconnect: () => process.exit(1),
})
process.exit(outcome === "disposed" ? 0 : 1)
