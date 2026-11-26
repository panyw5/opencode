import { homedir } from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as Log from "@opencode-ai/core/util/log"
import type { AcpConfig } from "./schema"

const log = Log.create({ service: "agent-backend.antigravity" })

/** `--flag value`, accepting both `--a-b`/`--a_b` spellings and `--flag=value`. */
function flagValue(command: readonly string[], name: string) {
  const variants = [`--${name}`, `--${name.replaceAll("-", "_")}`]
  for (const variant of variants) {
    const index = command.findIndex((arg) => arg === variant)
    if (index >= 0 && command[index + 1]) return command[index + 1]
    const inline = command.find((arg) => arg.startsWith(`${variant}=`))
    if (inline) return inline.slice(variant.length + 1)
  }
  return undefined
}

async function exists(file: string) {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}

/**
 * Works around an agy ACP quirk: `session/list` aggregates conversations from
 * every app-data store under ~/.gemini (IDE, CLI, backups), but `session/load`
 * only opens files inside the process's own `--app-data-dir` (default
 * `antigravity-cli`). A session that lists but fails to load usually lives in
 * the IDE store — linking its conversation files into the active store makes
 * it loadable without mutating the source.
 */
export async function relinkAntigravitySession(config: AcpConfig, sessionID: string): Promise<boolean> {
  const binary = config.command[0]?.split("/").pop()
  if (binary !== "agy" && binary !== "agy.exe") return false
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return false
  const configuredGemini = flagValue(config.command, "gemini-dir")
  const geminiDir = configuredGemini
    ? path.isAbsolute(configuredGemini)
      ? configuredGemini
      : path.join(homedir(), configuredGemini)
    : path.join(homedir(), ".gemini")
  const store = flagValue(config.command, "app-data-dir") ?? "antigravity-cli"
  const conversations = path.join(geminiDir, store, "conversations")
  const target = path.join(conversations, `${sessionID}.db`)
  if (await exists(target)) return false
  const entries = await fs.readdir(geminiDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === store) continue
    const source = path.join(geminiDir, entry.name, "conversations", `${sessionID}.db`)
    if (!(await exists(source))) continue
    await fs.mkdir(conversations, { recursive: true })
    for (const suffix of ["", "-wal", "-shm"]) {
      if (!(await exists(source + suffix)) || (await exists(target + suffix))) continue
      try {
        await fs.symlink(source + suffix, target + suffix)
      } catch (error) {
        log.warn(`relink failed session=${sessionID} file=${target + suffix} error=${String(error)}`)
        if (!suffix) return false
      }
    }
    log.info(`relinked session=${sessionID} from=${entry.name} to=${store}`)
    return true
  }
  return false
}
