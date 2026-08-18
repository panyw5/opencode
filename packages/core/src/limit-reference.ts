const QUALIFIERS = ["preview", "latest", "beta", "alpha", "exp", "experimental"] as const
const DATE_TOKEN = /^(?:\d{8}|\d{6}|\d{4})$/
const OPENROUTER_ID = "openrouter"

export type LimitReference = {
  context: number
  input?: number
  output?: number
  source: string
  matchedID: string
}

export type LimitCatalogModel = {
  id?: string
  limit?: {
    context?: number
    input?: number
    output?: number
  }
}

export type LimitCatalogProvider = {
  id?: string
  models: Record<string, LimitCatalogModel | undefined>
}

type TokenSet = {
  raw: string
  name: string
  tokens: string[]
  dates: string[]
  qualifiers: string[]
  stem: string
}

function lastSegment(id: string) {
  const parts = id.trim().toLowerCase().split("/").filter(Boolean)
  return parts.at(-1) ?? ""
}

export function tokenizeModelID(id: string): TokenSet {
  const raw = id.trim().toLowerCase()
  const name = lastSegment(raw)
  const tokens = name.split(/[^a-z0-9]+/).filter(Boolean)
  const dates = tokens.filter((token) => DATE_TOKEN.test(token))
  const qualifiers = tokens.filter((token) => (QUALIFIERS as readonly string[]).includes(token))
  const stem = tokens
    .filter((token) => !DATE_TOKEN.test(token) && !(QUALIFIERS as readonly string[]).includes(token))
    .join("-")
  return { raw, name, tokens, dates, qualifiers, stem }
}

function dateKeys(token: string) {
  const keys = [token]
  if (token.length === 8) {
    keys.push(token.slice(2), token.slice(4))
  } else if (token.length === 6) {
    keys.push(token.slice(2))
  }
  return keys
}

function datesOverlap(left: string[], right: string[]) {
  const keys = new Set(left.flatMap(dateKeys))
  return right.flatMap(dateKeys).some((key) => keys.has(key))
}

function dateCompatible(query: string[], candidate: string[]) {
  if (!query.length) return candidate.length === 0
  return candidate.length === 0 || datesOverlap(query, candidate)
}

function qualifierCompatible(query: string[], candidate: string[]) {
  if (!query.length) return candidate.length === 0
  return candidate.length === 0 || query.every((item) => candidate.includes(item))
}

function score(query: TokenSet, candidate: TokenSet, providerID: string) {
  if (!query.stem || query.stem !== candidate.stem) return undefined
  if (!dateCompatible(query.dates, candidate.dates)) return undefined
  if (!qualifierCompatible(query.qualifiers, candidate.qualifiers)) return undefined

  let value = 0
  if (candidate.name === query.name) value += 100
  if (candidate.raw === query.raw) value += 20
  if (query.dates.length && candidate.dates.length && datesOverlap(query.dates, candidate.dates)) value += 40
  else if (query.dates.length && !candidate.dates.length) value += 2
  if (!query.dates.length && !candidate.dates.length) value += 8
  if (query.qualifiers.length && query.qualifiers.every((item) => candidate.qualifiers.includes(item))) value += 20
  else if (query.qualifiers.length && !candidate.qualifiers.length) value += 2
  if (!query.qualifiers.length && !candidate.qualifiers.length) value += 6
  if (providerID === OPENROUTER_ID) value += 30
  return value
}

export function findLimitReference(
  modelID: string,
  catalog: Record<string, LimitCatalogProvider> | readonly LimitCatalogProvider[],
): LimitReference | undefined {
  const query = tokenizeModelID(modelID)
  if (!query.stem) return undefined

  const providers: Array<[string, LimitCatalogProvider]> = Array.isArray(catalog)
    ? catalog.map((provider, index) => [provider.id ?? String(index), provider])
    : Object.entries(catalog)

  let best:
    | {
        score: number
        providerID: string
        modelID: string
        model: LimitCatalogModel
      }
    | undefined

  for (const [providerID, provider] of providers) {
    for (const [id, model] of Object.entries(provider.models)) {
      if (!model) continue
      const value = score(query, tokenizeModelID(model.id ?? id), providerID)
      if (value === undefined) continue
      if (!best || value > best.score) {
        best = { score: value, providerID, modelID: id, model }
      }
    }
  }

  const context = best?.model.limit?.context ?? 0
  if (!best || context <= 0) return undefined
  return {
    context,
    input: best.model.limit?.input,
    output: best.model.limit?.output,
    source: best.providerID,
    matchedID: best.modelID,
  }
}

export * as LimitReference from "./limit-reference"
