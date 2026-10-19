import * as http from "node:http"
import * as tls from "node:tls"
import { createRemoteTunnelTransport, type TunnelStoreSnapshot } from "../src/index"

const target = process.argv[2]
if (!target || !/^127\.0\.0\.1:\d+$/.test(target)) throw new Error("QA bridge requires a loopback target")
tls.setDefaultCACertificates([...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])])
const configureProxy = Reflect.get(http, "setGlobalProxyFromEnv")
if (typeof configureProxy === "function") configureProxy.call(http)

let snapshot: TunnelStoreSnapshot = { version: 1, identities: {}, pending: {} }
const transport = await createRemoteTunnelTransport({
  load: async () => snapshot,
  save: async (next) => {
    snapshot = next
  },
})
const abort = new AbortController()
let closing: Promise<void> | undefined
const close = () => {
  if (closing) return closing
  closing = (async () => {
    abort.abort()
    try {
      await transport.remove()
    } finally {
      await transport.dispose()
    }
  })()
  return closing
}
const stopFromSignal = () => {
  void close().then(
    () => process.exit(0),
    () => {
      process.stderr.write("QA_BRIDGE_CLEANUP_FAILED\n")
      process.exit(1)
    },
  )
}
process.once("SIGTERM", stopFromSignal)
process.once("SIGINT", stopFromSignal)
const startupDeadline = setTimeout(() => abort.abort(), 180_000)
try {
  const connection = await transport.connect(target, abort.signal)
  clearTimeout(startupDeadline)
  process.stdout.write(`${JSON.stringify({ origin: `https://${connection.tunnel.hostname}` })}\n`)
  process.stdin.resume()
  await new Promise<void>((resolve) => process.stdin.once("end", resolve))
} catch (error) {
  const candidate = error as { code?: unknown; name?: unknown }
  const code = typeof candidate.code === "string" ? candidate.code : candidate.name
  process.stderr.write(
    `QA_BRIDGE_FAILED:${typeof code === "string" && /^[A-Z_a-z0-9.-]+$/.test(code) ? code : "unknown"}\n`,
  )
  process.exitCode = 1
} finally {
  clearTimeout(startupDeadline)
  await close().catch(() => {
    process.stderr.write("QA_BRIDGE_CLEANUP_FAILED\n")
    process.exitCode = 1
  })
}
