import { Path, type PathIdentity } from "@opencode-ai/core/util/path"
import { localPathContext } from "@/project/instance-context"

const disposers = new Set<(directoryKey: PathIdentity) => Promise<void>>()

export function registerDisposer(disposer: (directoryKey: PathIdentity) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export interface DisposeResult {
  readonly ok: boolean
  readonly failures: { readonly disposer: number; readonly error: unknown }[]
}

export async function disposeInstance(directory: string | PathIdentity): Promise<DisposeResult> {
  const directoryKey = Path.identity(directory, localPathContext)
  const settled = await Promise.allSettled([...disposers].map((disposer) => disposer(directoryKey)))
  const failures = settled
    .map((result, index) => ({ disposer: index, error: result.status === "rejected" ? result.reason : undefined }))
    .filter((failure) => failure.error !== undefined)
  return { ok: failures.length === 0, failures }
}
