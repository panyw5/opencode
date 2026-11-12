import { SECRET_MASK } from "@/extensions/api"
import type { SettingDefinition } from "@/extensions/types"

// Draft state for one setting row. Text-like controls (string/number/secret/
// enum) are kept as the raw input string; booleans as the switch state.
export type SettingDraftValue = string | boolean

export type SettingDraft = Record<string, SettingDraftValue>

// Draft values for every declared setting of one extension, seeded from the
// masked server snapshot and the manifest defaults.
export function initialDraft(
  definitions: Record<string, SettingDefinition>,
  stored: Record<string, unknown> | undefined,
): SettingDraft {
  const draft: SettingDraft = {}
  for (const [key, definition] of Object.entries(definitions)) {
    draft[key] = initialDraftValue(definition, stored?.[key])
  }
  return draft
}

// The value a control starts from: the server snapshot, falling back to the
// manifest default, falling back to the type's neutral value. Secrets never
// start from the stored value — the server only sends SECRET_MASK for
// configured secrets and the plaintext never crosses the API boundary.
export function initialDraftValue(definition: SettingDefinition, stored: unknown): SettingDraftValue {
  if (definition.type === "boolean") {
    if (typeof stored === "boolean") return stored
    if (typeof definition.default === "boolean") return definition.default
    return false
  }
  if (definition.secret) return ""
  if (definition.type === "number") {
    if (typeof stored === "number") return formatNumber(stored)
    if (typeof definition.default === "number") return formatNumber(definition.default)
    return ""
  }
  if (Array.isArray(definition.enum)) {
    if (definition.enum.some((option) => String(option) === String(stored))) return String(stored)
    if (definition.enum.some((option) => String(option) === String(definition.default))) {
      return String(definition.default)
    }
    return ""
  }
  if (typeof stored === "string") return stored
  if (typeof definition.default === "string") return definition.default
  return ""
}

// Numbers are normalized through String(Number(...)) so a stored `1e3` and a
// typed `1000` compare equal in the dirty check.
function formatNumber(value: number): string {
  return String(value)
}

function numberBaseline(definition: SettingDefinition, stored: unknown): string {
  if (typeof stored === "number") return formatNumber(stored)
  if (typeof definition.default === "number") return formatNumber(definition.default)
  return ""
}

function stringBaseline(definition: SettingDefinition, stored: unknown): string {
  if (definition.type === "number") return numberBaseline(definition, stored)
  if (typeof stored === "string") return stored
  if (typeof definition.default === "string") return definition.default
  return ""
}

export type ExtensionSettingsPatch = Record<string, unknown>

// Compares the drafts against the baselines and returns the patch to send, or
// undefined when nothing changed.
//
// `touched` lists the keys the user actually edited in the form. Only touched
// keys can enter the patch, so a secret that was never typed into is never
// overwritten by an empty draft.
//
// Rules:
// - Unchanged values are omitted ("keep the stored value").
// - A cleared string/number/enum becomes `null` so the server can drop the key
//   instead of storing an empty value.
// - A touched secret sends its new value, or `null` when the field was
//   cleared. An untouched field (which always displays empty) keeps the
//   stored secret.
// - SECRET_MASK never travels to the server from the web side; if the snapshot
//   somehow leaks into a draft it is treated as untouched.
// - An invalid number is skipped instead of sending garbage.
export function buildSettingsPatch(
  definitions: Record<string, SettingDefinition>,
  stored: Record<string, unknown> | undefined,
  draft: SettingDraft,
  touched?: ReadonlySet<string>,
): ExtensionSettingsPatch | undefined {
  const patch: ExtensionSettingsPatch = {}
  for (const [key, definition] of Object.entries(definitions)) {
    const value = draft[key]
    if (value === undefined) continue
    if (typeof value === "boolean") {
      if (definition.type !== "boolean") continue
      const baseline = initialDraftValue(definition, stored?.[key])
      if (value === baseline) continue
      patch[key] = value
      continue
    }
    if (definition.secret) {
      if (!touched?.has(key)) continue
      if (value === SECRET_MASK) continue
      patch[key] = value === "" ? null : value
      continue
    }
    if (definition.type === "number") {
      const input = value.trim()
      if (input === "") {
        if (numberBaseline(definition, stored?.[key]) === "") continue
        patch[key] = null
        continue
      }
      const parsed = Number(input)
      if (!Number.isFinite(parsed)) continue
      if (String(parsed) === numberBaseline(definition, stored?.[key])) continue
      patch[key] = parsed
      continue
    }
    if (Array.isArray(definition.enum)) {
      const match = definition.enum.find((option) => String(option) === value)
      const baseline = stringBaseline(definition, stored?.[key])
      if (match === undefined) {
        // "Not set" was selected: clear unless there was never a value.
        if (baseline === "") continue
        patch[key] = null
        continue
      }
      if (value === baseline) continue
      patch[key] = match
      continue
    }
    // Plain string.
    const baseline = stringBaseline(definition, stored?.[key])
    if (value === baseline) continue
    patch[key] = value === "" ? null : value
  }
  if (Object.keys(patch).length === 0) return undefined
  return patch
}

// Draft options for an enum setting: the declared choices plus a trailing
// "not set" entry (translated by the caller) that maps to null when saved.
export function enumDraftOptions(
  definition: SettingDefinition,
  unsetLabel: string,
): Array<{ value: string; label: string }> {
  const options = (definition.enum ?? []).map((option) => ({ value: String(option), label: String(option) }))
  options.push({ value: "", label: unsetLabel })
  return options
}

// True when the server reports a configured value for a secret. The stored
// value is always SECRET_MASK in that case; anything else the server sends
// (undefined) means the secret is not configured.
export function secretConfigured(stored: unknown): boolean {
  return stored === SECRET_MASK
}
