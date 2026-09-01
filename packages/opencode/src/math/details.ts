import type { MessageV2 } from "@/session/message-v2"
import { FactGraph, parseFrontmatter } from "./fact-graph"
import { GlobalMemory, type GlobalEntry } from "./global-memory"

export type MathDetailKind = "facts" | "correct" | "wrong" | "error"

export type MathVerificationReport = {
  summary: string
  criticalErrors: string[]
  gaps: string[]
}

export type MathFactDetail = {
  kind: "fact"
  id: string
  factId: string
  problemId: string
  author: string
  predecessors: string[]
  statement: string
  proof: string
  intuition?: string
  glossaryIntroduces: Record<string, string>
}

export type MathVerificationDetail = {
  kind: "correct" | "wrong" | "error"
  id: string
  timestamp: string
  workerSessionID?: string
  statement: string
  proof?: string
  evidence: string
  factId?: string
  writeError?: string
  error?: string
  report?: MathVerificationReport
}

export type MathDetailItem = MathFactDetail | MathVerificationDetail

export type MathDetailPage = {
  kind: MathDetailKind
  total: number
  offset: number
  limit: number
  items: MathDetailItem[]
}

export type MathVerificationAttempt = {
  workerSessionID: string
  statement: string
  proof: string
  verdict: "correct" | "wrong" | "error"
  timestamp: number
}

function sectionOf(text: string, heading: string): string {
  const out: string[] = []
  let active = false
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("## ")) {
      if (active) break
      active = line.trim().slice(3).trim().toLowerCase() === heading.toLowerCase()
      continue
    }
    if (active) out.push(line)
  }
  return out.join("\n").trim()
}

function frontmatterValue(text: string, key: string): string {
  const prefix = `${key}:`
  let delimiter = 0
  for (const line of text.split("\n")) {
    if (line.trim() === "---") {
      delimiter += 1
      if (delimiter === 2) break
      continue
    }
    if (!line.startsWith(prefix)) continue
    return line.slice(prefix.length).trim()
  }
  return ""
}

export function parseFactDetail(factId: string, text: string): MathFactDetail {
  const frontmatter = parseFrontmatter(text)
  const intuition = sectionOf(text, "intuition")
  return {
    kind: "fact",
    id: factId,
    factId,
    problemId: frontmatterValue(text, "problem_id"),
    author: frontmatterValue(text, "author"),
    predecessors: frontmatter.predecessors,
    statement: sectionOf(text, "statement"),
    proof: sectionOf(text, "proof"),
    intuition: intuition || undefined,
    glossaryIntroduces: frontmatter.glossary_introduces,
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function reportOf(value: unknown): MathVerificationReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const report = value as Record<string, unknown>
  if (typeof report.summary !== "string") return
  return {
    summary: report.summary,
    criticalErrors: stringList(report.critical_errors),
    gaps: stringList(report.gaps),
  }
}

function verificationKind(entry: GlobalEntry): MathVerificationDetail["kind"] {
  if (entry.verdict === "correct" || entry.verdict === "wrong") return entry.verdict
  return "error"
}

async function verificationDetail(
  factGraph: FactGraph,
  entry: GlobalEntry,
): Promise<MathVerificationDetail> {
  const kind = verificationKind(entry)
  const factId = typeof entry.fact_id === "string" ? entry.fact_id : undefined
  const rawFact = factId ? await factGraph.getRaw(factId) : undefined
  const proof = rawFact ? sectionOf(rawFact, "proof") : undefined
  return {
    kind,
    id: entry.id,
    timestamp: entry.timestamp_utc,
    workerSessionID: entry.author || undefined,
    statement: entry.claim,
    proof: proof || undefined,
    evidence: entry.evidence,
    factId,
    writeError: typeof entry.write_error === "string" ? entry.write_error : undefined,
    error: typeof entry.error === "string" ? entry.error : undefined,
    report: reportOf(entry.verification_report),
  }
}

export async function readMathDetailPage(input: {
  projectDir: string
  kind: MathDetailKind
  offset: number
  limit: number
}): Promise<MathDetailPage> {
  const factGraph = new FactGraph(input.projectDir)
  if (input.kind === "facts") {
    const ids = await factGraph.list()
    const selected = ids.slice(input.offset, input.offset + input.limit)
    const items = await Promise.all(
      selected.map(async (factId) => parseFactDetail(factId, (await factGraph.getRaw(factId)) ?? "")),
    )
    return { kind: input.kind, total: ids.length, offset: input.offset, limit: input.limit, items }
  }

  const verification = (await new GlobalMemory(input.projectDir).read("verification"))
    .filter((entry) => verificationKind(entry) === input.kind)
    .toSorted((a, b) => b.timestamp_utc.localeCompare(a.timestamp_utc))
  const selected = verification.slice(input.offset, input.offset + input.limit)
  const items = await Promise.all(selected.map((entry) => verificationDetail(factGraph, entry)))
  return { kind: input.kind, total: verification.length, offset: input.offset, limit: input.limit, items }
}

function attemptVerdict(output: unknown): MathVerificationAttempt["verdict"] | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return
  const result = output as Record<string, unknown>
  if (result.verdict === "correct" || result.verdict === "wrong" || result.verdict === "error") {
    return result.verdict
  }
  if (result.accepted === true) return "correct"
}

export function verificationAttempts(
  workerSessionID: string,
  messages: MessageV2.WithParts[],
): MathVerificationAttempt[] {
  const result: MathVerificationAttempt[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "math-truth_fact_submit") continue
      if (part.state.status !== "completed" && part.state.status !== "error") continue
      const statement = part.state.input.statement
      const proof = part.state.input.proof
      if (typeof statement !== "string" || typeof proof !== "string") continue
      let verdict: MathVerificationAttempt["verdict"] | undefined
      if (part.state.status === "error") {
        verdict = "error"
      } else {
        try {
          verdict = attemptVerdict(JSON.parse(part.state.output))
        } catch {
          verdict = undefined
        }
      }
      if (!verdict) continue
      result.push({
        workerSessionID,
        statement,
        proof,
        verdict,
        timestamp: part.state.time.end,
      })
    }
  }
  return result
}

export function attachVerificationProofs(
  page: MathDetailPage,
  attempts: MathVerificationAttempt[],
): MathDetailPage {
  const byKey = new Map<string, MathVerificationAttempt[]>()
  for (const attempt of attempts) {
    const key = `${attempt.workerSessionID}\u0000${attempt.verdict}\u0000${attempt.statement}`
    const entries = byKey.get(key)
    if (entries) entries.push(attempt)
    else byKey.set(key, [attempt])
  }
  return {
    ...page,
    items: page.items.map((item) => {
      if (item.kind === "fact" || item.proof || !item.workerSessionID) return item
      const key = `${item.workerSessionID}\u0000${item.kind}\u0000${item.statement}`
      const candidates = byKey.get(key)
      if (!candidates?.length) return item
      const timestamp = Date.parse(item.timestamp)
      const index = candidates.reduce((best, candidate, candidateIndex) => {
        if (!Number.isFinite(timestamp)) return best
        const current = candidates[best]
        if (!current) return candidateIndex
        const bestDistance = Math.abs(current.timestamp - timestamp)
        const distance = Math.abs(candidate.timestamp - timestamp)
        return distance < bestDistance ? candidateIndex : best
      }, 0)
      const [attempt] = candidates.splice(index, 1)
      return attempt ? { ...item, proof: attempt.proof } : item
    }),
  }
}

export * as MathDetails from "./details"
