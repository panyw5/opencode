import { Document, isMap, isScalar, parseDocument } from "yaml"

function credentialDocument(text: string) {
  const doc = text.trim() ? parseDocument(text) : new Document({})
  // YAML parser messages can contain the offending credential value.
  if (doc.errors.length || !isMap(doc.contents)) throw new Error("Invalid DSH credentials document")
  const version = doc.get("version")
  if (version !== undefined && version !== 1) throw new Error("Unsupported DSH credentials version")
  const refs = version === 1 ? doc.get("refs", true) : doc.contents
  if (refs !== undefined && !isMap(refs)) throw new Error("Invalid DSH credential references")
  if (isMap(refs)) {
    for (const { key, value } of refs.items) {
      if (!isScalar(key) || typeof key.value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key.value)) {
        throw new Error("Invalid DSH credential reference name")
      }
      if (!isScalar(value) || typeof value.value !== "string" || !value.value.trim()) {
        throw new Error("Invalid DSH credential reference value")
      }
    }
  }
  return { doc, refs, version }
}

export function parseDshCredentials(text: string): Map<string, string> {
  const { refs } = credentialDocument(text)
  return new Map(isMap(refs) ? refs.items.map(({ key, value }) => [String(key), String(value)]) : [])
}

export function updateDshCredential(text: string, key: string, value: string | undefined): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid DSH credential reference name")
  if (value !== undefined && !value.trim()) throw new Error("DSH credential must not be empty")
  const { doc, version } = credentialDocument(text)
  const path = version === 1 ? ["refs", key] : [key]
  if (value === undefined) {
    if (!doc.hasIn(path)) return text
    doc.deleteIn(path)
  } else doc.setIn(path, value)
  return doc.toString()
}

export function serializeDshCredentials(refs: ReadonlyMap<string, string>): string {
  return new Document(Object.fromEntries([...refs].sort(([a], [b]) => a.localeCompare(b)))).toString()
}
