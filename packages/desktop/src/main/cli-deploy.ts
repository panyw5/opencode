import { randomUUID } from "node:crypto"
import { copyFile, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

const WINDOWS_REPLACEMENT_ATTEMPTS = 5
const WINDOWS_REPLACEMENT_DELAY_MS = 200

type CliDeployOperations = {
  copyFile: typeof copyFile
  rename: typeof rename
  rm: typeof rm
  sleep: (milliseconds: number) => Promise<void>
  createTempPath: (target: string) => string
}

const defaultOperations: CliDeployOperations = {
  copyFile,
  rename,
  rm,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  createTempPath: (target) => join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`),
}

/**
 * Stages the executable beside its destination so a failed Windows replacement
 * leaves the previously installed CLI intact.
 */
export async function deployCli(input: {
  source: string
  target: string
  platform?: NodeJS.Platform
  attempts?: number
  retryDelayMs?: number
  operations?: Partial<CliDeployOperations>
}) {
  const operations = { ...defaultOperations, ...input.operations }
  const platform = input.platform ?? process.platform
  const attempts = platform === "win32" ? Math.max(1, input.attempts ?? WINDOWS_REPLACEMENT_ATTEMPTS) : 1
  const temp = operations.createTempPath(input.target)

  try {
    await operations.copyFile(input.source, temp)

    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await operations.rename(temp, input.target)
        return input.target
      } catch (error) {
        lastError = error
        if (platform !== "win32" || !isWindowsReplacementLock(error) || attempt === attempts) break
        await operations.sleep(input.retryDelayMs ?? WINDOWS_REPLACEMENT_DELAY_MS)
      }
    }

    if (platform === "win32" && isWindowsReplacementLock(lastError)) {
      throw new Error(
        `Could not update OpenCode CLI at ${input.target}: the destination executable may still be running. Close opencode.exe and retry. ${errorMessage(lastError)}`,
        { cause: lastError },
      )
    }
    throw new Error(`Could not install OpenCode CLI at ${input.target}: ${errorMessage(lastError)}`, { cause: lastError })
  } finally {
    await operations.rm(temp, { force: true }).catch(() => undefined)
  }
}

function isWindowsReplacementLock(error: unknown) {
  if (!error || typeof error !== "object") return false
  const code = (error as NodeJS.ErrnoException).code
  return code === "EACCES" || code === "EBUSY" || code === "EPERM"
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
