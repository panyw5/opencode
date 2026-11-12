import { chmod, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Absolute source entry shared by Bun, Node and the bundled Electron probe. */
export const ownershipWorker = fileURLToPath(new URL("./fixtures/ownership-worker.mjs", import.meta.url))

/**
 * Allocate a private guard directory that is removed only after its process/descriptor owners dispose.
 * @returns Canonical root, guard file and asynchronous directory cleanup.
 */
export async function ownershipStorage() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "oc-extension-ownership-")))
  await chmod(root, 0o700)
  return {
    root,
    file: path.join(root, "ownership.lock"),
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}
