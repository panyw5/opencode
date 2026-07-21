const BIND_ERROR_PATTERNS = ["eaddrinuse", "address already in use", "only one usage of each socket address"]

export function isAddressInUseError(error: unknown) {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
  const normalized = text.toLowerCase()
  return BIND_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))
}

export async function startWithPortRetry<T>(input: {
  component: string
  attempts?: number
  allocatePort: () => Promise<number>
  start: (port: number, attempt: number) => Promise<T>
}) {
  const attempts = Math.max(1, input.attempts ?? 3)
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await input.allocatePort()
    try {
      return await input.start(port, attempt)
    } catch (error) {
      lastError = error
      if (!isAddressInUseError(error) || attempt === attempts) break
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`${input.component} failed to start after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${detail}`, {
    cause: lastError,
  })
}
