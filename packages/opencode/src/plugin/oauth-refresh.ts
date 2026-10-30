import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import * as Log from "@opencode-ai/core/util/log"
import { createHash } from "node:crypto"

const log = Log.create({ service: "oauth.refresh" })
const pending = new Map<string, Promise<unknown>>()

// The operation must re-read credentials after acquiring the lock: another
// process may have rotated the refresh token while this caller was waiting.
export function refreshOAuth<A>(
  provider: string,
  endpoint: string,
  credential: string,
  operation: () => Promise<A>,
): Promise<A> {
  const identity = createHash("sha256").update(credential).digest("hex")
  const key = `oauth-refresh:${Global.Path.data}:${provider}:${endpoint}:${identity}`
  const current = pending.get(key)
  if (current) {
    log.info("joining credential refresh", { provider })
    return current as Promise<A>
  }
  log.info("waiting for credential refresh lock", { provider })
  const next = Flock.withLock(
    key,
    async () => {
      log.info("credential refresh lock acquired", { provider })
      return operation()
    },
    { timeoutMs: 60_000 },
  ).then(
    (value) => {
      pending.delete(key)
      log.info("credential refresh completed", { provider })
      return value
    },
    (error) => {
      pending.delete(key)
      log.warn("credential refresh failed", { provider, error: error instanceof Error ? error.name : "unknown" })
      throw error
    },
  )
  pending.set(key, next)
  return next
}
