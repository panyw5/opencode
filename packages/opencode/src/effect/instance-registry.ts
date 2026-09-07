import { Path, type PathIdentity } from "@opencode-ai/core/util/path"
import { localPathContext } from "@/project/instance-context"

const disposers = new Set<(directoryKey: PathIdentity) => Promise<void>>()

export function registerDisposer(disposer: (directoryKey: PathIdentity) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string | PathIdentity) {
  const directoryKey = Path.identity(directory, localPathContext)
  await Promise.allSettled([...disposers].map((disposer) => disposer(directoryKey)))
}
