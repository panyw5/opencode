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

export function findModelPresets(catalog: ModelCatalog, providerID: string, modelID: string): ModelPresets | undefined {
  const id = modelID.trim().toLowerCase()
  const name = modelName(id)
  if (!name) return
  const provider = providerID.trim().toLowerCase()
  const namespace = id.includes("/") ? id.split("/")[0] : ""
  const matches = Object.entries(catalog).flatMap(([source, item]) =>
    Object.entries(item.models).flatMap(([key, model]) => {
      const matchedID = typeof model.id === "string" ? model.id : key
      const matchedName = modelName(matchedID)
      if (matchedName !== name && modelName(key) !== name && modelFamily(matchedName) !== modelFamily(name)) return []
      const rows = modelConfig(model)
      return [
        {
          source,
          matchedID,
          model,
          rows,
          origin: Number(MODEL_ORIGIN_PROVIDERS.has(source)),
          current: Number(source === provider),
          namespace: Number(source === namespace),
          exact: Number(matchedID.toLowerCase() === id || key.toLowerCase() === id),
          family: Number(modelFamily(modelName(matchedID)) === modelFamily(name)),
          populated: rows.filter((row) => row.value !== "").length,
        },
      ]
    }),
  )
  const exactMatches = matches.filter((item) => item.exact)
  const candidates = exactMatches.length ? exactMatches : matches.filter((item) => item.family)
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
