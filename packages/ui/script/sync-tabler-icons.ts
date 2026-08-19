import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type Style = "outline" | "filled"

// Existing OpenCode IconName -> Tabler asset. Unmapped names keep the hand-drawn set.
const tablerByName: Record<string, { file: string; style?: Style }> = {
  "align-right": { file: "align-right" },
  "arrow-up": { file: "arrow-up" },
  "arrow-up-bold": { file: "arrow-up" },
  "arrow-left": { file: "arrow-left" },
  "arrow-right": { file: "arrow-right" },
  "arrow-sync": { file: "refresh" },
  archive: { file: "archive" },
  "bell-off": { file: "bell-off" },
  "bubble-5": { file: "message-circle" },
  prompt: { file: "message-2" },
  book: { file: "book" },
  brain: { file: "brain" },
  robot: { file: "robot" },
  fork: { file: "git-fork" },
  "bullet-list": { file: "list" },
  "check-small": { file: "check" },
  play: { file: "player-play" },
  "chevron-down": { file: "chevron-down" },
  "chevron-left": { file: "chevron-left" },
  "chevron-right": { file: "chevron-right" },
  "chevron-grabber-vertical": { file: "grip-vertical" },
  "chevron-double-right": { file: "chevrons-right" },
  "circle-x": { file: "circle-x" },
  close: { file: "x" },
  "close-small": { file: "x" },
  checklist: { file: "list-check" },
  clock: { file: "clock" },
  console: { file: "terminal-2" },
  terminal: { file: "terminal-2" },
  "terminal-active": { file: "terminal-2" },
  review: { file: "article" },
  read: { file: "file-text" },
  "review-active": { file: "article", style: "filled" },
  expand: { file: "arrows-maximize" },
  "expand-corners": { file: "arrows-diagonal" },
  collapse: { file: "arrows-minimize" },
  code: { file: "code" },
  "code-lines": { file: "code" },
  "circle-ban-sign": { file: "ban" },
  "edit-small-2": { file: "pencil" },
  eye: { file: "eye" },
  enter: { file: "corner-down-left" },
  file: { file: "file" },
  folder: { file: "folder" },
  "file-tree": { file: "binary-tree" },
  "tree-nodes": { file: "binary-tree-2" },
  "file-tree-active": { file: "binary-tree", style: "filled" },
  "magnifying-glass": { file: "search" },
  "plus-small": { file: "plus" },
  plus: { file: "plus" },
  "new-session": { file: "square-plus" },
  "new-session-active": { file: "square-plus" },
  "pencil-line": { file: "pencil" },
  mcp: { file: "plug-connected" },
  glasses: { file: "eyeglass" },
  "magnifying-glass-menu": { file: "search" },
  "window-cursor": { file: "pointer" },
  task: { file: "checkbox" },
  stop: { file: "player-stop" },
  status: { file: "layout-rows" },
  "status-active": { file: "layout-rows" },
  sidebar: { file: "layout-sidebar" },
  "sidebar-active": { file: "layout-sidebar", style: "filled" },
  "layout-left": { file: "layout-sidebar" },
  "layout-left-partial": { file: "layout-sidebar" },
  "layout-left-full": { file: "layout-sidebar", style: "filled" },
  "layout-right": { file: "layout-sidebar-right" },
  "layout-right-partial": { file: "layout-sidebar-right" },
  "layout-right-full": { file: "layout-sidebar-right", style: "filled" },
  "layout-bottom": { file: "layout-bottombar" },
  "layout-bottom-partial": { file: "layout-bottombar" },
  "layout-bottom-full": { file: "layout-bottombar", style: "filled" },
  "square-arrow-top-right": { file: "external-link" },
  "open-file": { file: "external-link" },
  "speech-bubble": { file: "message-circle" },
  comment: { file: "message" },
  "folder-add-left": { file: "folder-plus" },
  github: { file: "brand-github" },
  discord: { file: "brand-discord" },
  "dot-grid": { file: "dots" },
  "circle-check": { file: "circle-check" },
  copy: { file: "copy" },
  check: { file: "check" },
  photo: { file: "photo" },
  share: { file: "share" },
  shield: { file: "shield" },
  download: { file: "download" },
  "shopping-bag": { file: "shopping-bag" },
  menu: { file: "menu-2" },
  server: { file: "server-2" },
  save: { file: "device-floppy" },
  branch: { file: "git-branch" },
  edit: { file: "pencil" },
  help: { file: "help" },
  "settings-gear": { file: "settings" },
  dash: { file: "minus" },
  "cloud-upload": { file: "cloud-upload" },
  trash: { file: "trash" },
  sliders: { file: "adjustments-horizontal" },
  keyboard: { file: "keyboard" },
  selector: { file: "selector" },
  "arrow-down-to-line": { file: "arrow-bar-to-down" },
  warning: { file: "alert-triangle" },
  reset: { file: "arrow-back-up" },
  refresh: { file: "refresh" },
  "refresh-small": { file: "refresh" },
  link: { file: "link" },
  providers: { file: "layout-grid" },
  models: { file: "sparkles" },
  "sticky-note": { file: "note" },
}

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, "..")
const assetRoots = [
  join(packageRoot, "node_modules/@tabler/icons/icons"),
  join(packageRoot, "../../node_modules/@tabler/icons/icons"),
  join(packageRoot, "../../node_modules/.bun/@tabler+icons@3.46.0/node_modules/@tabler/icons/icons"),
]

function assetDir() {
  for (const root of assetRoots) {
    if (existsSync(join(root, "outline"))) return root
  }
  throw new Error("Could not find @tabler/icons assets")
}

function assetPath(file: string, style: Style) {
  return join(assetDir(), style, `${file}.svg`)
}

function innerSvg(svg: string) {
  return svg
    .replace(/<\?xml[^>]*>/, "")
    .replace(/^<svg[\s\S]*?>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<path[^>]*d="M0 0h24v24H0z"[^/]*\/>/g, "")
    .replace(/\n\s*/g, "")
    .trim()
}

const missing: string[] = []
const entries = Object.entries(tablerByName)
  .map(([name, spec]) => {
    const style = spec.style ?? "outline"
    const path = assetPath(spec.file, style)
    if (!existsSync(path)) {
      missing.push(`${name} -> ${path}`)
      return undefined
    }
    return [name, { body: innerSvg(readFileSync(path, "utf8")), filled: style === "filled" }] as const
  })
  .filter((item): item is readonly [string, { body: string; filled: boolean }] => !!item)

if (missing.length) {
  throw new Error(`Missing Tabler assets:\n${missing.join("\n")}`)
}

const body = `// Generated by packages/ui/script/sync-tabler-icons.ts
// Do not edit by hand.

export const TABLER_VIEWBOX = "0 0 24 24"

export type TablerIconGlyph = {
  body: string
  filled: boolean
}

export const tablerIcons: Partial<Record<string, TablerIconGlyph>> = {
${entries
  .map(([name, glyph]) => `  ${JSON.stringify(name)}: ${JSON.stringify(glyph)},`)
  .join("\n")}
}
`

const out = join(packageRoot, "src/components/tabler-icons.ts")
writeFileSync(out, body)
console.log(`wrote ${entries.length} tabler icons to ${out}`)
