import { Effect } from "effect"
import { makeWith, spawnWorker } from "../../src/image/photon-runtime"

const worker = await Effect.runPromise(spawnWorker())
try {
  const normalize = makeWith(Effect.succeed(worker))
  const result = await Effect.runPromise(
    normalize("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", {
      autoResize: true,
      maxWidth: 2000,
      maxHeight: 2000,
      maxBase64Bytes: 5 * 1024 * 1024,
    }),
  )
  if (result.type !== "unchanged") throw new Error(`Unexpected image result: ${result.type}`)
  console.log("COMPILED_IMAGE_WORKER_OK")
} finally {
  await worker.terminate()
}
