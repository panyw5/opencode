import { homedir } from "node:os"
import { join, resolve } from "node:path"

export function resolveDesktopPath(path: string) {
  if (path === "~") return resolve(homedir())
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2))
  return resolve(path)
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
