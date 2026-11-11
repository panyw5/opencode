import type { ExtensionInfo } from "@/extensions/types"

const PREFIX = "extension:"

export function extensionPick(id: string) {
  return `${PREFIX}${id}`
}

export function parseExtensionPick(pick: string) {
  if (!pick.startsWith(PREFIX)) return
  const id = pick.slice(PREFIX.length)
  return id || undefined
}

/**
 * Normalize the extensions-section selection.
 *
 * `pick` may point at an installed extension ("extension:id"), a pending
 * catalog entry ("catalog:id") or something stale. Catalog picks survive host
 * refreshes while their entry stays visible; once the entry shows up in
 * `items` the pick migrates to the installed extension so the detail pane
 * follows the install. `catalog` lists the currently visible (pending)
 * catalog ids. An empty `items` list is a transient refresh state, so
 * parseable picks are preserved there (same contract as deep links).
 */
export function extensionSelection(items: readonly ExtensionInfo[], pick: string, catalog?: readonly string[]) {
  const id = parseExtensionPick(pick)
  if (id) {
    if (items.length === 0 || items.some((item) => item.id === id)) return pick
    return fallbackSelection(items, pick)
  }
  const catalogID = parseCatalogPick(pick)
  if (catalogID) {
    if (items.some((item) => item.id === catalogID)) {
      console.info(`[config-extensions] catalog pick migrated id=${catalogID} installed=${items.length}`)
      return extensionPick(catalogID)
    }
    if (items.length === 0 || catalog === undefined || catalog.includes(catalogID)) return pick
  }
  return fallbackSelection(items, pick)
}

function fallbackSelection(items: readonly ExtensionInfo[], pick: string) {
  if (items.length === 0) return ""
  const next = extensionPick(items[0].id)
  console.info(`[config-extensions] selection normalized from=${pick || "(empty)"} to=${next} installed=${items.length}`)
  return next
}

export function extensionSelectionKey(items: readonly ExtensionInfo[]) {
  return JSON.stringify(items.map((item) => item.id))
}

const CATALOG_PREFIX = "catalog:"

export function catalogPick(id: string) {
  return `${CATALOG_PREFIX}${id}`
}

export function parseCatalogPick(pick: string) {
  if (!pick.startsWith(CATALOG_PREFIX)) return
  return pick.slice(CATALOG_PREFIX.length) || undefined
}
