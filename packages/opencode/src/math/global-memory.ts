import { createHash } from "crypto"
import path from "path"
import { tokenize, bm25Scores } from "./bm25"
import { appendJsonl, readJsonl } from "./jsonl"
import { layout } from "./layout"
import { GLOBAL_KINDS, STATUSES, dumps, isGlobalKind, isStatus, type GlobalKind, type Status } from "./schema"

const STATUS_LOG = "_status.jsonl"

export type GlobalEntry = {
  id: string
  timestamp_utc: string
  author: string
  kind: GlobalKind
  claim: string
  evidence: string
  verifiable: boolean
  status: Status
  fact_id: string | null
  links: Record<string, unknown>
  glossary: Record<string, string>
  [extra: string]: unknown
}

export class GlobalMemory {
  readonly dir: string

  constructor(root: string) {
    this.dir = layout(root).globalMemory
  }

  private pathFor(kind: string): string {
    return path.join(this.dir, `${kind}.jsonl`)
  }

  async append(input: {
    kind: string
    claim: string
    evidence: string
    author: string
    verifiable?: boolean
    links?: Record<string, unknown>
    glossary?: Record<string, string>
    extra?: Record<string, unknown>
  }): Promise<string> {
    if (!isGlobalKind(input.kind)) {
      throw new Error(`unknown kind '${input.kind}'. Known: ${Object.keys(GLOBAL_KINDS).sort().join(", ")}`)
    }
    const verifiable = input.verifiable ?? GLOBAL_KINDS[input.kind]
    if (verifiable && !(input.evidence || "").trim()) {
      throw new Error(`kind '${input.kind}' is verifiable and requires explicit evidence`)
    }
    const ts = new Date().toISOString()
    const entryId = createHash("sha256")
      .update(dumps([input.kind, input.claim, input.author, ts]), "utf8")
      .digest("hex")
      .slice(0, 16)
    const entry: Record<string, unknown> = {
      id: entryId,
      timestamp_utc: ts,
      author: input.author,
      kind: input.kind,
      claim: input.claim,
      evidence: input.evidence,
      verifiable,
      status: verifiable ? "unverified" : "open",
      fact_id: null,
      links: input.links ?? {},
      glossary: input.glossary ?? {},
      ...input.extra,
    }
    await appendJsonl(this.pathFor(input.kind), entry)
    return entryId
  }

  async setStatus(entryId: string, status: string, factId?: string | null): Promise<void> {
    if (!isStatus(status)) throw new Error(`invalid status '${status}'. Valid: ${STATUSES.join(", ")}`)
    await appendJsonl(path.join(this.dir, STATUS_LOG), {
      timestamp_utc: new Date().toISOString(),
      id: entryId,
      status,
      fact_id: factId ?? null,
    })
  }

  private async latestStatus(): Promise<Map<string, Record<string, unknown>>> {
    const latest = new Map<string, Record<string, unknown>>()
    for (const rec of await readJsonl(path.join(this.dir, STATUS_LOG))) {
      const id = rec.id
      if (typeof id === "string") latest.set(id, rec)
    }
    return latest
  }

  async read(kind: string): Promise<GlobalEntry[]> {
    const latest = await this.latestStatus()
    const out: GlobalEntry[] = []
    for (const e of await readJsonl(this.pathFor(kind))) {
      const st = typeof e.id === "string" ? latest.get(e.id) : undefined
      const folded = st
        ? { ...e, status: st.status, fact_id: st.fact_id ?? e.fact_id }
        : e
      out.push(folded as GlobalEntry)
    }
    return out
  }

  async search(
    query: string,
    kinds?: string[],
    limitPerKind = 10,
  ): Promise<{ query: string; results_by_kind: Record<string, { count: number; results: Array<{ score: number; entry: GlobalEntry }> }> }> {
    const latest = await this.latestStatus()
    const out: Record<string, { count: number; results: Array<{ score: number; entry: GlobalEntry }> }> = {}
    const selected = kinds?.length ? kinds : Object.keys(GLOBAL_KINDS)
    for (const kind of selected) {
      const entries = await readJsonl(this.pathFor(kind))
      const docs = entries.map((e) => tokenize(dumps(e)))
      const scores = bm25Scores(query, docs)
      const ranked: Array<{ score: number; entry: GlobalEntry }> = []
      const order = entries.map((_, i) => i).sort((a, b) => scores[b] - scores[a])
      for (const i of order) {
        if (scores[i] <= 0) break
        let e = entries[i]
        const st = typeof e.id === "string" ? latest.get(e.id) : undefined
        if (st) e = { ...e, status: st.status, fact_id: st.fact_id ?? e.fact_id }
        ranked.push({ score: scores[i], entry: e as GlobalEntry })
        if (ranked.length >= limitPerKind) break
      }
      out[kind] = { count: ranked.length, results: ranked }
    }
    return { query, results_by_kind: out }
  }
}

export * as MathGlobalMemory from "./global-memory"
