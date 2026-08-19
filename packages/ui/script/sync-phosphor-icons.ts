import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type Weight = "regular" | "fill"

// Existing OpenCode IconName -> Phosphor asset. Unmapped names keep the hand-drawn set.
const phosphorByName: Record<string, { file: string; weight?: Weight }> = {
  "align-right": { file: "text-align-right" },
  "arrow-up": { file: "arrow-up" },
  "arrow-up-bold": { file: "arrow-up" },
  "arrow-left": { file: "arrow-left" },
  "arrow-right": { file: "arrow-right" },
  "arrow-sync": { file: "arrows-clockwise" },
  archive: { file: "archive" },
  "bell-off": { file: "bell-slash" },
  "bubble-5": { file: "chat-circle" },
  prompt: { file: "chat-teardrop" },
  book: { file: "book" },
  brain: { file: "brain" },
  robot: { file: "robot" },
  fork: { file: "git-fork" },
  "bullet-list": { file: "list-bullets" },
  "check-small": { file: "check" },
  play: { file: "play" },
  "chevron-down": { file: "caret-down" },
  "chevron-left": { file: "caret-left" },
  "chevron-right": { file: "caret-right" },
  "chevron-grabber-vertical": { file: "dots-six-vertical" },
  "chevron-double-right": { file: "caret-double-right" },
  "circle-x": { file: "x-circle" },
  close: { file: "x" },
  "close-small": { file: "x" },
  checklist: { file: "list-checks" },
  clock: { file: "clock" },
  console: { file: "terminal-window" },
  terminal: { file: "terminal-window" },
  "terminal-active": { file: "terminal-window", weight: "fill" },
  review: { file: "article" },
  read: { file: "file-text" },
  "review-active": { file: "article", weight: "fill" },
  expand: { file: "arrows-out" },
  "expand-corners": { file: "arrows-out-cardinal" },
  collapse: { file: "arrows-in" },
  code: { file: "code" },
  "code-lines": { file: "code" },
  "circle-ban-sign": { file: "prohibit" },
  "edit-small-2": { file: "pencil-simple" },
  eye: { file: "eye" },
  enter: { file: "key-return" },
  file: { file: "file" },
  folder: { file: "folder" },
  "file-tree": { file: "tree-structure" },
  "tree-nodes": { file: "tree-structure" },
  "file-tree-active": { file: "tree-structure", weight: "fill" },
  "magnifying-glass": { file: "magnifying-glass" },
  "plus-small": { file: "plus" },
  plus: { file: "plus" },
  "new-session": { file: "plus-square" },
  "new-session-active": { file: "plus-square", weight: "fill" },
  "pencil-line": { file: "pencil-simple-line" },
  mcp: { file: "plugs-connected" },
  glasses: { file: "eyeglasses" },
  "magnifying-glass-menu": { file: "magnifying-glass" },
  "window-cursor": { file: "cursor" },
  task: { file: "check-square" },
  stop: { file: "stop" },
  status: { file: "rows" },
  "status-active": { file: "rows", weight: "fill" },
  sidebar: { file: "sidebar" },
  "sidebar-active": { file: "sidebar", weight: "fill" },
  "layout-left": { file: "sidebar-simple" },
  "square-arrow-top-right": { file: "arrow-square-out" },
  "open-file": { file: "arrow-square-out" },
  "speech-bubble": { file: "chat-circle" },
  comment: { file: "chat" },
  "folder-add-left": { file: "folder-plus" },
  github: { file: "github-logo" },
  discord: { file: "discord-logo" },
  "dot-grid": { file: "dots-three" },
  "circle-check": { file: "check-circle" },
  copy: { file: "copy" },
  check: { file: "check" },
  photo: { file: "image" },
  share: { file: "export" },
  shield: { file: "shield" },
  download: { file: "download-simple" },
  "shopping-bag": { file: "shopping-bag" },
  menu: { file: "list" },
  server: { file: "hard-drives" },
  save: { file: "floppy-disk" },
  branch: { file: "git-branch" },
  edit: { file: "pencil-simple" },
  help: { file: "question" },
  "settings-gear": { file: "gear" },
  dash: { file: "minus" },
  "cloud-upload": { file: "cloud-arrow-up" },
  trash: { file: "trash" },
  sliders: { file: "sliders-horizontal" },
  keyboard: { file: "keyboard" },
  selector: { file: "caret-up-down" },
  "arrow-down-to-line": { file: "arrow-line-down" },
  warning: { file: "warning" },
  reset: { file: "arrow-u-up-left" },
  refresh: { file: "arrows-clockwise" },
  "refresh-small": { file: "arrows-clockwise" },
  link: { file: "link" },
  providers: { file: "squares-four" },
  models: { file: "sparkle" },
  "sticky-note": { file: "note" },
}

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, "..")
const assetRoots = [
  join(packageRoot, "node_modules/@phosphor-icons/core/assets"),
  join(packageRoot, "../../node_modules/@phosphor-icons/core/assets"),
  join(packageRoot, "../../node_modules/.bun/@phosphor-icons+core@2.1.1/node_modules/@phosphor-icons/core/assets"),
]

function assetDir(weight: Weight) {
  for (const root of assetRoots) {
    const dir = join(root, weight)
    if (existsSync(dir)) return dir
  }
  throw new Error("Could not find @phosphor-icons/core assets")
}

function assetPath(file: string, weight: Weight) {
  const name = weight === "fill" ? `${file}-fill.svg` : `${file}.svg`
  return join(assetDir(weight), name)
}

function innerSvg(svg: string) {
  return svg
    .replace(/<\?xml[^>]*>/, "")
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .trim()
}

const missing: string[] = []
const entries = Object.entries(phosphorByName)
  .map(([name, spec]) => {
    const weight = spec.weight ?? "regular"
    const path = assetPath(spec.file, weight)
    if (!existsSync(path)) {
      missing.push(`${name} -> ${path}`)
      return undefined
    }
    return [name, innerSvg(readFileSync(path, "utf8"))] as const
  })
  .filter((item): item is readonly [string, string] => !!item)

if (missing.length) {
  throw new Error(`Missing Phosphor assets:\n${missing.join("\n")}`)
}

const body = `// Generated by packages/ui/script/sync-phosphor-icons.ts
// Do not edit by hand.

export const PHOSPHOR_VIEWBOX = "0 0 256 256"

export const phosphorIcons: Partial<Record<string, string>> = {
${entries
  .map(([name, svg]) => `  ${JSON.stringify(name)}: ${JSON.stringify(svg)},`)
  .join("\n")}
}
`

const out = join(packageRoot, "src/components/phosphor-icons.ts")
writeFileSync(out, body)
console.log(`wrote ${entries.length} phosphor icons to ${out}`)
