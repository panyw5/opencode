import { homedir } from "node:os"
import { join, resolve } from "node:path"

export function resolveDesktopPath(path: string) {
  if (path === "~") return resolve(homedir())
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

export function configRoot(input: { env?: NodeJS.ProcessEnv; home?: string } = {}) {
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const resolveConfigPath = (value: string) => {
    if (value === "~") return resolve(home)
    if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(home, value.slice(2))
    return resolve(value)
  }

  if (env.OPENCODE_CONFIG_DIR) return resolveConfigPath(env.OPENCODE_CONFIG_DIR)
  if (env.XDG_CONFIG_HOME) return resolveConfigPath(join(env.XDG_CONFIG_HOME, "opencode"))
  return resolve(home, ".config", "opencode")
}

export function cliInstallDirectory(input: {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
} = {}) {
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  if ((input.platform ?? process.platform) === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "opencode", "bin")
  }
  return join(home, ".local", "bin")
}

export function attachmentExtension(input?: string): string {
  const extension = (input ?? "md").trim().replace(/^\.+/, "").toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,15}$/.test(extension)) return "md"
  return extension
}

export function tempMarkdownAttachmentPath(directory: string, input: { id: string; now: Date; extension?: string }): string {
  const root = resolveDesktopPath(directory)
  const stamp = input.now.toISOString().replace(/[:.]/g, "-")
  return join(root, ".opencode", "tmp", "attachments", `prompt-${stamp}-${input.id}.${attachmentExtension(input.extension)}`)
}
