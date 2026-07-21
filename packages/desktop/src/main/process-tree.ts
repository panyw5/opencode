import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"

type ProcessTreeChild = Pick<ChildProcess, "pid" | "kill">

export function terminateProcessTree(
  child: ProcessTreeChild,
  input: { platform?: NodeJS.Platform; spawnTaskkill?: typeof spawn } = {},
): Promise<void> {
  if ((input.platform ?? process.platform) !== "win32" || !child.pid) {
    child.kill("SIGTERM")
    return Promise.resolve()
  }

  const spawnTaskkill = input.spawnTaskkill ?? spawn
  return new Promise((resolve) => {
    const killer = spawnTaskkill("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
    killer.once("exit", resolve)
    killer.once("error", () => {
      child.kill()
      resolve()
    })
  })
}
