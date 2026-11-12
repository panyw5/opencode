// Dependency-free so the CLI entry can drain without loading the extension stack.
const pending = new Set<Promise<unknown>>()

/** Background work that holds mkdir lease gates and must not be cut off by process.exit(). */
export function track<T>(work: Promise<T>) {
  pending.add(work)
  void work.finally(() => pending.delete(work)).catch(() => {})
  return work
}

export async function drain(timeoutMs = 10_000) {
  if (!pending.size) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  clearTimeout(timer)
}

export * as ExtensionDrain from "./drain"
