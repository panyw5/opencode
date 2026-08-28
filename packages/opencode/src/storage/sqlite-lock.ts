import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "db.sqlite-lock" })

const DEFAULT_ATTEMPTS = 4
const DEFAULT_BASE_DELAY_MS = 25
const DEFAULT_MAX_DELAY_MS = 500

type SQLiteErrorLike = {
  message?: unknown
  name?: unknown
  code?: unknown
  errno?: unknown
  cause?: unknown
}

export type SQLiteLockRetryOptions = {
  operation: string
  databasePath?: string
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

function errorParts(error: unknown) {
  const parts: SQLiteErrorLike[] = []
  const seen = new Set<unknown>()
  let current: unknown = error

  while (current && typeof current === "object" && !seen.has(current) && parts.length < 10) {
    seen.add(current)
    const value = current as SQLiteErrorLike
    parts.push(value)
    current = value.cause
  }

  return parts
}

function errorText(error: unknown) {
  const parts = errorParts(error)
  if (parts.length === 0) return String(error).toLowerCase()
  return parts
    .flatMap((part) => [part.message, part.name, part.code, part.errno])
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .map(String)
    .join(" ")
    .toLowerCase()
}

function errorDetails(error: unknown) {
  const first = errorParts(error)[0]
  return {
    error: first?.message ? String(first.message) : String(error),
    name: first?.name === undefined ? undefined : String(first.name),
    code: first?.code === undefined ? undefined : String(first.code),
    errno: first?.errno === undefined ? undefined : Number(first.errno),
  }
}

/**
 * Bun and Node expose different SQLite lock errors. Some runtimes preserve
 * SQLITE_BUSY, while DatabaseSync may only retain the failed BEGIN statement.
 */
export function isSQLiteLockError(error: unknown): boolean {
  const text = errorText(error)
  if (text.includes("sqlite_busy") || text.includes("sqlite_locked")) return true
  if (text.includes("database is locked") || text.includes("database table is locked")) return true
  return /failed to (?:run|execute) (?:the )?query\s+['"`]?begin immediate/i.test(text)
}

function sleepSync(milliseconds: number) {
  if (milliseconds <= 0) return
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, milliseconds)
}

/**
 * Retry a synchronous SQLite operation when another process temporarily owns
 * the write lock. The callback must be safe to repeat until it commits.
 */
export function withSQLiteLockRetry<T>(run: (attempt: number) => T, options: SQLiteLockRetryOptions): T {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS))
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS)
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS)

  for (let attempt = 1; attempt <= attempts; attempt++) {
    log.debug("sqlite lock operation attempt", {
      operation: options.operation,
      databasePath: options.databasePath,
      attempt,
      attempts,
    })

    try {
      const result = run(attempt)
      log.debug("sqlite lock operation succeeded", {
        operation: options.operation,
        databasePath: options.databasePath,
        attempt,
        attempts,
      })
      return result
    } catch (error) {
      const locked = isSQLiteLockError(error)
      const details = errorDetails(error)
      log.warn("sqlite lock operation failed", {
        operation: options.operation,
        databasePath: options.databasePath,
        attempt,
        attempts,
        locked,
        ...details,
      })

      if (!locked || attempt === attempts) {
        log.error("sqlite lock operation giving up", {
          operation: options.operation,
          databasePath: options.databasePath,
          attempt,
          attempts,
          locked,
          ...details,
        })
        throw error
      }

      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
      log.info("sqlite lock operation backing off", {
        operation: options.operation,
        databasePath: options.databasePath,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
      })
      sleepSync(delayMs)
    }
  }

  throw new Error(`SQLite lock retry exhausted: ${options.operation}`)
}

export * as SQLiteLock from "./sqlite-lock"
