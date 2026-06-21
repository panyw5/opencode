import type { RootLoadArgs } from "./types"

const DEFAULT_ROOT_SESSION_LOAD_TIMEOUT_MS = 30_000

export class RootSessionLoadTimeoutError extends Error {
  constructor(directory: string, timeoutMs: number) {
    super(`Timed out loading sessions for ${directory} after ${timeoutMs}ms`)
    this.name = "RootSessionLoadTimeoutError"
  }
}

export async function loadRootSessions(input: RootLoadArgs) {
  const timeoutMs = input.timeoutMs ?? DEFAULT_ROOT_SESSION_LOAD_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RootSessionLoadTimeoutError(input.directory, timeoutMs)), timeoutMs)
  })

  // Cache all roots for a directory. Sidebar components own visible limits, so
  // the shared directory store must not be clipped by whichever view loads first.
  try {
    const result = await Promise.race([input.list({ directory: input.directory, roots: true }), timeout])
    return {
      data: result.data,
    } as const
  } finally {
    if (timer) clearTimeout(timer)
  }
}
