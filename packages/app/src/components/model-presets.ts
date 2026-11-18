import { MODEL_CONFIG_FIELDS, modelConfig } from "./dialog-custom-provider-form"

export type ModelCatalog = Record<string, { models: Record<string, Record<string, unknown>> }>
export type ModelPresets = { source: string; values: Record<string, string>; approximate?: boolean }

const MODEL_ORIGIN_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "mistral",
  "xai",
  "cohere",
  "moonshotai",
  "zhipuai",
  "alibaba",
  "minimax",
  "perplexity",
  "meta",
  "nvidia",
  "ai21",
])

function modelName(id: string) {
  return id.trim().toLowerCase().split("/").at(-1) ?? ""
}

function modelFamily(name: string) {
  const parts = name.split("-")
  return parts.length > 1 ? parts.slice(0, -1).join("-") : ""
}

type CatalogCandidate = {
  source: string
  key: string
  matchedID: string
  familyKey: string
  model: Record<string, unknown>
}

type CatalogIndex = {
  byName: Map<string, CatalogCandidate[]>
  byFamily: Map<string, CatalogCandidate[]>
}

// Scanning the whole catalog (~9k models) per lookup made every model row pay
// O(catalog) when a custom provider form mounted. Index once per catalog
// object so lookups are O(candidates).
const catalogIndexes = new WeakMap<ModelCatalog, CatalogIndex>()

function catalogIndex(catalog: ModelCatalog): CatalogIndex {
  const cached = catalogIndexes.get(catalog)
  if (cached) return cached
  const index: CatalogIndex = { byName: new Map(), byFamily: new Map() }
  const add = (map: Map<string, CatalogCandidate[]>, key: string, candidate: CatalogCandidate) => {
    const list = map.get(key)
    if (list) list.push(candidate)
    else map.set(key, [candidate])
  }
  for (const [source, item] of Object.entries(catalog)) {
    for (const [key, model] of Object.entries(item.models)) {
      const matchedID = typeof model.id === "string" ? model.id : key
      const matchedName = modelName(matchedID)
      const candidate: CatalogCandidate = {
        source,
        key,
        matchedID,
        familyKey: modelFamily(matchedName),
        model,
      }
      add(index.byName, matchedName, candidate)
      const keyName = modelName(key)
      if (keyName !== matchedName) add(index.byName, keyName, candidate)
      add(index.byFamily, candidate.familyKey, candidate)
    }
  }
  catalogIndexes.set(catalog, index)
  return index
}

export function findModelPresets(catalog: ModelCatalog, providerID: string, modelID: string): ModelPresets | undefined {
  const id = modelID.trim().toLowerCase()
  const name = modelName(id)
  if (!name) return
  const provider = providerID.trim().toLowerCase()
  const namespace = id.includes("/") ? id.split("/")[0] : ""
  const index = catalogIndex(catalog)
  const family = modelFamily(name)
  const pool = new Set<CatalogCandidate>([...(index.byName.get(name) ?? []), ...(index.byFamily.get(family) ?? [])])
  const matches = [...pool].map((item) => ({
    ...item,
    origin: Number(MODEL_ORIGIN_PROVIDERS.has(item.source)),
    current: Number(item.source === provider),
    namespace: Number(item.source === namespace),
    exact: Number(item.matchedID.toLowerCase() === id || item.key.toLowerCase() === id),
    familyMatch: Number(item.familyKey === family),
  }))
  const exactMatches = matches.filter((item) => item.exact)
  const candidates = (exactMatches.length ? exactMatches : matches.filter((item) => item.familyMatch)).map(
    (item) => {
      const rows = modelConfig(item.model)
      return { ...item, rows, populated: rows.filter((row) => row.value !== "").length }
    },
  )
  if (!candidates.length) return
  // Choose one reference record, not a consensus across resellers with different limits.
  // A family match is only a fallback for model aliases such as gpt-5.6-astra.
  candidates.sort(
    (a, b) =>
      b.origin - a.origin ||
      b.namespace - a.namespace ||
      b.current - a.current ||
      b.exact - a.exact ||
      b.populated - a.populated ||
      a.source.localeCompare(b.source) ||
      a.matchedID.localeCompare(b.matchedID),
  )
  const match = candidates[0]

  const values: Record<string, string> = {}
  for (const field of MODEL_CONFIG_FIELDS) {
    // Keep connection settings out of model metadata presets. Values are only applied on explicit clicks.
    if (["provider.npm", "provider.api", "options", "headers", "variants", "experimental"].includes(field.key)) continue
    const raw = match.model[field.key]
    if (field.kind === "boolean" && typeof raw !== "boolean") continue
    if (field.kind === "string" && typeof raw !== "string") continue
    const value = match.rows.find((row) => row.key === field.key)?.value
    if (!value) continue
    values[field.key] = value
  }
  return {
    source: `${match.source}/${match.matchedID}`,
    values,
    approximate: !match.exact,
  }
}
