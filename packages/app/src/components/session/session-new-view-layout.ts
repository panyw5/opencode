export function sessionNewPane(width: number) {
  if (width >= 2200) return "96rem"
  if (width >= 1800) return "88rem"
  if (width >= 1500) return "80rem"
  if (width >= 1280) return "72rem"
  return "64rem"
}

export function sessionNewMeta(agent: boolean) {
  if (agent) return ""
  return "md:max-w-[var(--session-content-width)] md:mx-auto"
}

export type SessionNewOpenFolderKey =
  | "command.project.openInFinder"
  | "command.project.openInFileExplorer"
  | "command.project.openInFileManager"

export function sessionNewOpenFolderKey(os?: string): SessionNewOpenFolderKey {
  if (os === "windows") return "command.project.openInFileExplorer"
  if (os === "macos") return "command.project.openInFinder"
  return "command.project.openInFileManager"
}

export function sessionNewCanOpenFolder(input: {
  platform?: string
  os?: string
  local?: boolean
  openPath?: boolean
  openInFinder?: boolean
}) {
  if (input.platform !== "desktop" || !input.local) return false
  return input.os === "windows" ? !!input.openPath : !!input.openInFinder
}

export function sessionNewOpenFolderVia(os?: string) {
  return os === "windows" ? "openPath" : "openInFinder"
}
