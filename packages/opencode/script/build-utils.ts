import fs from "fs"
import path from "path"

const dir = path.resolve(import.meta.dir, "..")
const DIST = path.join(dir, "dist")
const LOCK = path.join(DIST, ".build.lock")
const STALE_MS = 30 * 60 * 1000
const WAIT_MS = 10 * 60 * 1000

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we cannot signal it; ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function lockStale() {
  try {
    const raw = fs.readFileSync(path.join(LOCK, "owner"), "utf8")
    const owner = JSON.parse(raw) as { pid?: number; at?: number }
    if (typeof owner.pid === "number" && pidAlive(owner.pid)) return false
    return true
  } catch {
    // Owner metadata missing/corrupt: stale if the lock dir is old.
    try {
      return Date.now() - fs.statSync(LOCK).mtimeMs > STALE_MS
    } catch {
      return true
    }
  }
}

/**
 * Serializes dist/ writes across concurrent invocations of build.ts and
 * build-node.ts (and parallel predev runs). Directory-as-lock is atomic on
 * POSIX and Windows; the owner record enables stale-lock reclamation when a
 * builder dies mid-run.
 */
export async function acquireBuildLock(name: string) {
  await fs.promises.mkdir(DIST, { recursive: true })
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    try {
      fs.mkdirSync(LOCK)
      fs.writeFileSync(path.join(LOCK, "owner"), JSON.stringify({ pid: process.pid, name, at: Date.now() }))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (lockStale()) {
        await fs.promises.rm(LOCK, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${LOCK} (held by another ${name} build?)`)
      }
      await Bun.sleep(500)
    }
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    await fs.promises.rm(LOCK, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Windows rename races with anything still holding a handle on the old tree:
 * a just-executed smoke test binary, Defender/indexer scans, or a host's file
 * watcher. Those release within seconds, so retry briefly instead of failing
 * an otherwise-good build.
 */
async function renameWithRetry(from: string, to: string, attempts = 20) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.promises.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES"
      if (!retryable || attempt >= attempts) throw error
      await Bun.sleep(250 * attempt)
    }
  }
}

/**
 * Atomically publishes a fully-built staging directory into place. Readers
 * (electron-vite bundling, runtime CLIs) only ever see the complete previous
 * or next tree — never a half-written one. The old tree is moved aside first
 * so the swap window is a rename, not a delete+rebuild.
 */
export async function publishDir(staging: string, target: string) {
  const trash = `${target}.trash-${process.pid}-${Date.now()}`
  await fs.promises.rm(trash, { recursive: true, force: true })
  if (fs.existsSync(target)) await renameWithRetry(target, trash)
  try {
    await renameWithRetry(staging, target)
  } catch (error) {
    if (fs.existsSync(trash) && !fs.existsSync(target)) {
      await fs.promises.rename(trash, target).catch(() => {})
    }
    throw error
  }
  await fs.promises.rm(trash, { recursive: true, force: true }).catch(() => {})
}
