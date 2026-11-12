/**
 * Built-in extension catalog: hardcoded placeholder entries the install UI
 * offers to users ("available extensions"). Installation itself stays an
 * explicit user action through the regular install dialog; nothing here
 * auto-installs or phones home. A remote marketplace (P3b) would replace
 * this list's source, not its consumers.
 */
export type CatalogEntry = {
  id: string
  name: string
  author: string
  releaseUrl: string
}

export const builtinCatalog: CatalogEntry[] = [
  {
    id: "local.wls-repl",
    name: "WolframScript REPL",
    author: "panyw5",
    releaseUrl: "https://raw.githubusercontent.com/panyw5/open-extensions/main/wls-repl/stable.json",
  },
  {
    id: "local.mathematica-notebook",
    name: "Mathematica Notebook",
    author: "panyw5",
    releaseUrl: "https://raw.githubusercontent.com/panyw5/open-extensions/main/mathematica-notebook/stable.json",
  },
]

/** Catalog entries whose extension id is not installed yet. */
export function pendingCatalogEntries(installedIds: readonly string[]): CatalogEntry[] {
  const installed = new Set(installedIds)
  return builtinCatalog.filter((entry) => !installed.has(entry.id))
}
