import { createHash } from "crypto"

/** kind → default `verifiable`. Matches Danus GLOBAL_KINDS. */
export const GLOBAL_KINDS = {
  conclusion: true,
  example: true,
  counterexample: true,
  proof_attempt: true,
  plan: false,
  dead_end: false,
  direction: false,
  obstacle: false,
  master_guidance: false,
  verification: false,
  elaboration: false,
} as const

export type GlobalKind = keyof typeof GLOBAL_KINDS

export const STATUSES = [
  "unverified",
  "verifying",
  "verified",
  "refuted",
  "open",
  "supported",
  "challenged",
] as const

export type Status = (typeof STATUSES)[number]

export const EXTERNAL_REF_KEYS = [
  "key",
  "authors",
  "title",
  "arxiv",
  "year",
  "venue",
  "doi",
  "cited_for",
] as const

export type ExternalRef = Record<string, unknown>

export type Fact = {
  fact_id: string
  problem_id: string
  author: string
  predecessors: string[]
  statement: string
  proof: string
  glossary_introduces: Record<string, string>
  intuition: string
  external_refs: ExternalRef[]
}

export function isGlobalKind(value: string): value is GlobalKind {
  return value in GLOBAL_KINDS
}

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value)
}

/** Whitespace-stable canonical form for content hashing. */
export function normalize(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim()
}

/**
 * Python `json.dumps(..., ensure_ascii=False, separators=(", ", ": "))`.
 * `sortKeys` matches `sort_keys=True` (recursive). Used so `fact_id` matches Danus.
 */
export function dumps(value: unknown, options?: { sortKeys?: boolean }): string {
  return encode(value, options?.sortKeys === true)
}

function encode(value: unknown, sortKeys: boolean): string {
  if (value === null || value === undefined) return "null"
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false"
    case "number":
      if (!Number.isFinite(value)) throw new Error(`non-finite number: ${value}`)
      return Number.isInteger(value) ? String(value) : JSON.stringify(value)
    case "string":
      return JSON.stringify(value)
    case "object": {
      if (Array.isArray(value)) {
        if (value.length === 0) return "[]"
        return "[" + value.map((item) => encode(item, sortKeys)).join(", ") + "]"
      }
      const rec = value as Record<string, unknown>
      const keys = sortKeys ? Object.keys(rec).sort() : Object.keys(rec)
      if (keys.length === 0) return "{}"
      return "{" + keys.map((key) => JSON.stringify(key) + ": " + encode(rec[key], sortKeys)).join(", ") + "}"
    }
    default:
      throw new Error(`cannot serialize ${typeof value}`)
  }
}

export function cleanExternalRefs(refs: unknown): ExternalRef[] {
  if (!refs || !Array.isArray(refs)) return []
  const out: ExternalRef[] = []
  for (const r of refs) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue
    const rec = r as Record<string, unknown>
    const ordered: ExternalRef = {}
    for (const k of EXTERNAL_REF_KEYS) {
      if (k in rec) ordered[k] = rec[k]
    }
    for (const k of Object.keys(rec).sort()) {
      if (!(k in ordered)) ordered[k] = rec[k]
    }
    out.push(ordered)
  }
  return out
}

/**
 * Deterministic 16-hex SHA-256 of canonical content (Danus scheme).
 * `external_refs` is deliberately excluded — mutable bibliographic metadata.
 */
export function computeFactId(input: {
  problem_id: string
  predecessors: string[]
  glossary_introduces: Record<string, string>
  statement: string
  proof: string
}): string {
  const glossary = Object.fromEntries(
    Object.entries(input.glossary_introduces)
      .map(([k, v]) => [String(k), String(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  const body = {
    glossary_introduces: glossary,
    predecessors: [...input.predecessors].sort(),
    problem_id: input.problem_id,
    proof: normalize(input.proof),
    statement: normalize(input.statement),
  }
  const canon = dumps(body, { sortKeys: true })
  return createHash("sha256").update(canon, "utf8").digest("hex").slice(0, 16)
}

export * as MathSchema from "./schema"
