import semver from "semver"
import { fetchReleaseDescriptor } from "./catalog-install"

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

/** Whether a release's declared engines range accepts the running host build. */
export type HostCompatibility = {
  ok: boolean
  /** False when the descriptor carries no engines.opencode declaration. */
  declared: boolean
  range?: string
}

/**
 * Mirrors the install-time engines.opencode gate (plugin/shared.ts): a missing
 * range means unrestricted-but-undeclared, and a host version that is not a
 * usable semver (development "local" builds, major 0) skips the gate entirely.
 */
export function hostCompatibility(
  engines: { opencode?: string } | undefined,
  hostVersion: string | undefined,
): HostCompatibility {
  const range = engines?.opencode
  if (typeof range !== "string") return { ok: true, declared: false }
  if (typeof hostVersion !== "string" || !semver.valid(hostVersion) || semver.major(hostVersion) === 0)
    return { ok: true, declared: true, range }
  return { ok: semver.satisfies(hostVersion, range), declared: true, range }
}

const compatibilityCache = new Map<string, Promise<HostCompatibility>>()

/**
 * Fetch only the release descriptor — never the artifact — and evaluate its
 * declared engines range against the running host. Verdicts are cached per
 * descriptor URL; failures are evicted so a later try can recover.
 */
export function catalogCompatibility(releaseUrl: string, doFetch: typeof fetch, hostVersion: string | undefined) {
  let pending = compatibilityCache.get(releaseUrl)
  if (!pending) {
    pending = fetchReleaseDescriptor(releaseUrl, doFetch)
      .then((descriptor) => hostCompatibility(descriptor.engines, hostVersion))
      .catch((error: unknown) => {
        compatibilityCache.delete(releaseUrl)
        throw error
      })
    compatibilityCache.set(releaseUrl, pending)
  }
  return pending
}

/** Test hook: drop cached compatibility verdicts. */
export function resetCatalogCompatibility() {
  compatibilityCache.clear()
}
