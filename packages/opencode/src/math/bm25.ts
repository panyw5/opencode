const TOKEN_RE = /[A-Za-z0-9_]+/g

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []) as string[]
}

/**
 * One BM25 score per already-tokenized document. k1=1.5, b=0.75 (Danus).
 * Corpus is re-tokenized per call; no persisted index.
 */
export function bm25Scores(
  query: string,
  documents: string[][],
  options?: { k1?: number; b?: number },
): number[] {
  const k1 = options?.k1 ?? 1.5
  const b = options?.b ?? 0.75
  const queryTokens = tokenize(query)
  if (!queryTokens.length || !documents.length) return documents.map(() => 0)

  const queryTermCounts = count(queryTokens)
  const documentTermCounts = documents.map(count)
  const documentLengths = documents.map((doc) => doc.length)
  const avgDocLength = documentLengths.reduce((a, n) => a + n, 0) / documentLengths.length
  const totalDocuments = documents.length

  const documentFrequencies = new Map<string, number>()
  for (const doc of documents) {
    for (const token of new Set(doc)) {
      documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1)
    }
  }

  return documentTermCounts.map((docCounts, i) => {
    const docLength = documentLengths[i]
    const norm = avgDocLength > 0 ? k1 * (1.0 - b + b * (docLength / avgDocLength)) : k1
    let score = 0
    for (const [token, queryTf] of queryTermCounts) {
      const tf = docCounts.get(token) ?? 0
      if (tf <= 0) continue
      const df = documentFrequencies.get(token) ?? 0
      const idf = Math.log(1.0 + (totalDocuments - df + 0.5) / (df + 0.5))
      score += queryTf * idf * ((tf * (k1 + 1.0)) / (tf + norm))
    }
    return score
  })
}

function count(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const t of tokens) map.set(t, (map.get(t) ?? 0) + 1)
  return map
}

export * as MathBm25 from "./bm25"
