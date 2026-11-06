import { directoryBrowseLeaf, displayToAbsolute, type BrowseEntry } from "./dialog-select-directory"

export function filterDirectoryEntries(entries: BrowseEntry[], query: string) {
  const needle = directoryBrowseLeaf(query).toLocaleLowerCase()
  return entries.filter((entry) => entry.name.toLocaleLowerCase().startsWith(needle))
}

export function moveDirectoryHighlight(current: number, count: number, key: "ArrowDown" | "ArrowUp", open: boolean) {
  if (count <= 0) return 0
  if (!open) return key === "ArrowDown" ? 0 : count - 1
  return key === "ArrowDown" ? Math.min(count - 1, current + 1) : Math.max(0, current - 1)
}

/** Empty optional fields stay empty; absolute-only settings resolve display paths before saving. */
export function directoryInputValue(query: string, home: string, absolute: boolean) {
  if (!query || !absolute) return query
  return displayToAbsolute(query, home, home)
}
