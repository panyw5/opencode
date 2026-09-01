const GREEK = (
  "alpha beta gamma delta epsilon eta theta iota kappa lambda mu nu xi pi rho " +
  "sigma tau phi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega"
).split(" ")

const INTERESTING = new RegExp(
  "\\b(" +
    "[A-Za-z][A-Za-z]?(?:_\\{[^}]+\\}|_[A-Za-z0-9+]+)+(?:\\([^)\\s]{0,30}\\))?" +
    "|[A-Z][A-Z]?(?:\\([^)\\s]{0,30}\\)|\\+|>=\\d+|<=\\d+)" +
    "|" +
    GREEK.slice()
      .sort((a, b) => b.length - a.length)
      .join("|") +
    "|\\{[a-zA-Z]\\}|\\[[a-z],\\s*[a-z]\\]|\\([a-z],\\s*[a-z]\\)" +
    ")",
  "g",
)

const STOPLIST = new Set([
  "I",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "OR",
  "AND",
  "NOT",
  "IF",
  "THEN",
  "QED",
  "PROOF",
  "LEMMA",
  "THEOREM",
  "CLAIM",
])

/** Small universal-notation set. Advisory; the verifier is the backstop. */
export const UNIVERSAL_TERMS = new Set([
  "Z",
  "Z+",
  "Z_+",
  "N",
  "Q",
  "R",
  "R+",
  "R_+",
  "C",
  "epsilon",
  "delta",
  "alpha",
  "beta",
  "gamma",
  "gcd",
  "lcm",
  "mod",
])

export function flatten(glossary: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!glossary || typeof glossary !== "object") return out
  const rec = glossary as Record<string, unknown>
  const terms = rec.terms && typeof rec.terms === "object" && !Array.isArray(rec.terms) ? (rec.terms as Record<string, unknown>) : rec
  for (const [term, entry] of Object.entries(terms)) {
    if (term === "version" || term === "description" || term === "terms") continue
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const defn = String((entry as { definition?: unknown }).definition ?? "")
      out[String(term)] = defn
      const aliases = (entry as { aliases?: unknown }).aliases
      if (Array.isArray(aliases)) {
        for (const alias of aliases) out[String(alias)] = defn
      }
    } else if (typeof entry === "string") {
      out[String(term)] = entry
    }
  }
  return out
}

export function undefinedSymbols(input: {
  statement: string
  proof: string
  intuition?: string
  defined: Iterable<string>
}): string[] {
  const defined = new Set(input.defined)
  const found = new Map<string, true>()
  for (const text of [input.statement, input.proof, input.intuition ?? ""]) {
    INTERESTING.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = INTERESTING.exec(text || ""))) {
      const tok = m[1]
      if (STOPLIST.has(tok) || defined.has(tok)) continue
      const stripped = tok.replace(/\([^)]*\)$/, "")
      if (stripped && defined.has(stripped)) continue
      found.set(tok, true)
    }
  }
  return [...found.keys()].sort()
}

export * as MathGlossary from "./glossary"
