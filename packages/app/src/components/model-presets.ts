import { MODEL_CONFIG_FIELDS, modelConfig } from "./dialog-custom-provider-form"

export type ModelCatalog = Record<string, { models: Record<string, Record<string, unknown>> }>
export type ModelPresets = { source: string; values: Record<string, string> }

export function findModelPresets(catalog: ModelCatalog, providerID: string, modelID: string): ModelPresets | undefined {
  const id = modelID.trim()
  const provider = providerID.trim()
  if (!id) return
  const get = (provider: string, id: string) => {
    const item = Object.hasOwn(catalog, provider) ? catalog[provider] : undefined
    return item && Object.hasOwn(item.models, id) ? item.models[id] : undefined
  }
  const exact = get(provider, id)
  const slash = id.indexOf("/")
  const origin = slash > 0 ? id.slice(0, slash) : ""
  const originModel = get(origin, id) ?? get(origin, id.slice(slash + 1))
  const matches = exact
    ? [{ provider, model: exact }]
    : originModel
      ? [{ provider: origin, model: originModel }]
      : Object.keys(catalog).flatMap((provider) => {
          const model = get(provider, id)
          return model ? [{ provider, model }] : []
        })
  if (!matches.length) return

  const rows = matches.map(({ model }) => modelConfig(model))
  const values: Record<string, string> = {}
  for (const field of MODEL_CONFIG_FIELDS) {
    // Connection settings are not model metadata. Cross-provider prices are not transferable.
    if (["provider.npm", "provider.api", "options", "headers", "variants", "experimental"].includes(field.key)) continue
    if (field.key.startsWith("cost.") && !exact) continue
    const raw = matches[0].model[field.key]
    if (field.kind === "boolean" && typeof raw !== "boolean") continue
    if (field.kind === "string" && typeof raw !== "string") continue
    const value = rows[0].find((row) => row.key === field.key)?.value
    if (!value || !rows.every((items) => items.find((row) => row.key === field.key)?.value === value)) continue
    values[field.key] = value
  }
  return { source: matches.map(({ provider, model }) => `${provider}/${model.id ?? id}`).join(", "), values }
}
