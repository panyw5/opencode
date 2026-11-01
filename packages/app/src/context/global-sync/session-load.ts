import type { RootLoadArgs } from "./types"

const DEFAULT_ROOT_SESSION_LOAD_TIMEOUT_MS = 30_000

export class RootSessionLoadTimeoutError extends Error {
  constructor(directory: string, timeoutMs: number) {
    super(`Timed out loading sessions for ${directory} after ${timeoutMs}ms`)
    this.name = "RootSessionLoadTimeoutError"
  }
}

export async function loadRootSessions(input: RootLoadArgs) {
  const directory = input.directory.replace(/\\/g, "/")
  const timeoutMs = input.timeoutMs ?? DEFAULT_ROOT_SESSION_LOAD_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new RootSessionLoadTimeoutError(directory, timeoutMs)
      console.debug(`[session-list] timeout phase=request timeoutMs=${timeoutMs}`)
      reject(error)
      controller.abort(error)
    }, timeoutMs)
  })

  // Cache all roots for a directory. Sidebar components own visible limits, so
  // the shared directory store must not be clipped by whichever view loads first.
  try {
    const load = async () => {
      const resolved = input.resolveDirectory ? await input.resolveDirectory(directory, controller.signal) : directory
      // An adapter may complete after cancellation. Never start another request for a retired load.
      controller.signal.throwIfAborted()
      const result = await input.list({ directory: resolved, roots: true }, controller.signal)
      controller.signal.throwIfAborted()
      return { data: result.data, directory: resolved } as const
    }
    return await Promise.race([load(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
