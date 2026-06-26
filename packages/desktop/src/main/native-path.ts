import { homedir } from "node:os"
import { join, resolve } from "node:path"

const TRELLIS_TASK_NAME_MAX = 120

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

export function trellisTaskFolderName(name: string): string {
  const normalized = name
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, TRELLIS_TASK_NAME_MAX)
  if (!normalized) throw new Error("Task name must contain a valid folder name")
  if (normalized === "archive") throw new Error("Task name cannot be archive")
  return normalized
}
