import { readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

// Only folder names and canonical paths are exposed, never file contents.
export async function remoteDirectory(input: string, list: boolean) {
  if (!input || input.length > 8192 || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new Error("Invalid directory path")
  }
  const expanded = input === "~" ? homedir() : /^~[\\/]/.test(input) ? join(homedir(), input.slice(2)) : input
  if (!isAbsolute(expanded)) throw new Error("Absolute directory path required")
  const path = await realpath(resolve(expanded))
  if (!(await stat(path)).isDirectory()) throw new Error("Not a directory")
  const entries = list ? await readdir(path, { withFileTypes: true }) : []
  return {
    path,
    entries: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ path: join(path, entry.name), kind: "directory" as const })),
  }
}
