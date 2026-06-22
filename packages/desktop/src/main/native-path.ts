import { homedir } from "node:os"
import { join, resolve } from "node:path"

export function resolveDesktopPath(path: string) {
  if (path === "~") return resolve(homedir())
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

export function tempMarkdownAttachmentPath(directory: string, input: { id: string; now: Date }): string {
  const root = resolveDesktopPath(directory)
  const stamp = input.now.toISOString().replace(/[:.]/g, "-")
  return join(root, ".opencode", "tmp", "attachments", `prompt-${stamp}-${input.id}.md`)
}
