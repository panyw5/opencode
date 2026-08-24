import { access, mkdir, readFile, readdir, rename, writeFile } from "fs/promises"
import path from "path"
import { tokenize, bm25Scores } from "./bm25"
import { UNIVERSAL_TERMS, undefinedSymbols } from "./glossary"
import { appendJsonl } from "./jsonl"
import { layout } from "./layout"
import {
  type ExternalRef,
  type Fact,
  cleanExternalRefs,
  computeFactId,
  dumps,
} from "./schema"

const PRED_RE = /^predecessors:\s*\[(.*)\]\s*$/
const GLOSS_LINE_RE = /^\s{2}([^:]+):\s*(.*)$/

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

export function statementOf(text: string): string {
  const out: string[] = []
  let inStmt = false
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("## ")) {
      if (inStmt) break
      inStmt = line.trim().toLowerCase() === "## statement"
      continue
    }
    if (inStmt) out.push(line.trim())
  }
  return out.filter(Boolean).join(" ").trim()
}

export function serializeFact(fact: Fact): string {
  const lines = [
    "---",
    `fact_id: ${fact.fact_id}`,
    `problem_id: ${fact.problem_id}`,
    `author: ${fact.author}`,
    `predecessors: [${fact.predecessors.join(", ")}]`,
  ]
  if (Object.keys(fact.glossary_introduces).length) {
    lines.push("glossary_introduces:")
    for (const k of Object.keys(fact.glossary_introduces).sort()) {
      lines.push(`  ${k}: ${fact.glossary_introduces[k]}`)
    }
  } else {
    lines.push("glossary_introduces: {}")
  }
  lines.push("external_refs: " + dumps(fact.external_refs))
  lines.push("---", "", "## statement", fact.statement.trim(), "", "## proof", fact.proof.trim())
  if (fact.intuition.trim()) lines.push("", "## intuition", fact.intuition.trim())
  lines.push("")
  return lines.join("\n")
}

export function parseFrontmatter(text: string): {
  predecessors: string[]
  glossary_introduces: Record<string, string>
  external_refs: ExternalRef[]
} {
  let preds: string[] = []
  const gloss: Record<string, string> = {}
  let refs: ExternalRef[] = []
  let inGloss = false
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i > 0 && line.trim() === "---") break
    const m = PRED_RE.exec(line.trim())
    if (m) {
      preds = m[1]
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
      inGloss = false
      continue
    }
    if (line.trim().startsWith("glossary_introduces:")) {
      inGloss = !line.includes("{}")
      continue
    }
    if (line.trim().startsWith("external_refs:")) {
      inGloss = false
      const payload = line.trim().slice("external_refs:".length).trim()
      try {
        const parsed = payload ? JSON.parse(payload) : []
        refs = Array.isArray(parsed) ? (parsed as ExternalRef[]) : []
      } catch {
        refs = []
      }
      continue
    }
    if (inGloss) {
      const gm = GLOSS_LINE_RE.exec(line)
      if (gm) gloss[gm[1].trim()] = gm[2].trim()
      else inGloss = false
    }
  }
  return { predecessors: preds, glossary_introduces: gloss, external_refs: refs }
}

export class FactGraph {
  readonly root: string
  readonly factsDir: string
  readonly revokedDir: string
  readonly glossaryPath: string
  readonly revocationLog: string

  constructor(root: string) {
    const l = layout(root)
    this.root = root
    this.factsDir = l.facts
    this.revokedDir = l.revoked
    this.glossaryPath = l.glossary
    this.revocationLog = l.revocationLog
  }

  pathFor(factId: string): string {
    return path.join(this.factsDir, `${factId}.md`)
  }

  async exists(factId: string): Promise<boolean> {
    return pathExists(this.pathFor(factId))
  }

  async list(): Promise<string[]> {
    try {
      const names = await readdir(this.factsDir)
      return names
        .filter((n) => n.endsWith(".md"))
        .map((n) => n.slice(0, -3))
        .sort()
    } catch {
      return []
    }
  }

  async getRaw(factId: string): Promise<string | undefined> {
    try {
      return await readFile(this.pathFor(factId), "utf8")
    } catch {
      return undefined
    }
  }

  async glossary(): Promise<Record<string, string>> {
    try {
      const text = await readFile(this.glossaryPath, "utf8")
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  async add(input: {
    problem_id: string
    author: string
    statement: string
    proof: string
    predecessors?: string[]
    glossary_introduces?: Record<string, string>
    intuition?: string
    external_refs?: ExternalRef[]
  }): Promise<string> {
    const predecessors = (input.predecessors ?? []).filter(Boolean)
    const glossary_introduces = input.glossary_introduces ?? {}
    const external_refs = cleanExternalRefs(input.external_refs)
    for (const pid of predecessors) {
      if (await pathExists(path.join(this.revokedDir, `${pid}.md`))) {
        throw new Error(`predecessor_revoked: ${pid}`)
      }
    }
    const fact_id = computeFactId({
      problem_id: input.problem_id,
      predecessors,
      glossary_introduces,
      statement: input.statement,
      proof: input.proof,
    })
    const fact: Fact = {
      fact_id,
      problem_id: input.problem_id,
      author: input.author,
      predecessors,
      statement: input.statement,
      proof: input.proof,
      glossary_introduces,
      intuition: input.intuition ?? "",
      external_refs,
    }
    await mkdir(this.factsDir, { recursive: true })
    await writeFile(this.pathFor(fact_id), serializeFact(fact), "utf8")
    await this.mergeGlossary(glossary_introduces)
    return fact_id
  }

  private async mergeGlossary(next: Record<string, string>): Promise<void> {
    if (!Object.keys(next).length) return
    const cur = await this.glossary()
    for (const [k, v] of Object.entries(next)) cur[String(k)] = String(v)
    await mkdir(path.dirname(this.glossaryPath), { recursive: true })
    await writeFile(this.glossaryPath, JSON.stringify(cur, null, 2), "utf8")
  }

  async search(query: string, limit = 10): Promise<Array<{ fact_id: string; score: number; statement: string }>> {
    const fids = await this.list()
    if (!fids.length) return []
    const raws = await Promise.all(fids.map(async (fid) => (await this.getRaw(fid)) ?? ""))
    const docs = raws.map((r) => tokenize(r))
    const scores = bm25Scores(query, docs)
    const ranked: Array<{ fact_id: string; score: number; statement: string }> = []
    const order = fids.map((fid, i) => i).sort((a, b) => scores[b] - scores[a])
    for (const i of order) {
      if (scores[i] <= 0) break
      ranked.push({ fact_id: fids[i], score: scores[i], statement: statementOf(raws[i]) })
      if (ranked.length >= limit) break
    }
    return ranked
  }

  async predecessors(factId: string): Promise<string[]> {
    const raw = (await this.getRaw(factId)) ?? ""
    return parseFrontmatter(raw).predecessors
  }

  async externalRefs(factId: string): Promise<ExternalRef[]> {
    const raw = (await this.getRaw(factId)) ?? ""
    return parseFrontmatter(raw).external_refs
  }

  async setExternalRefs(factId: string, externalRefs: ExternalRef[]): Promise<ExternalRef[]> {
    const p = this.pathFor(factId)
    let text: string
    try {
      text = await readFile(p, "utf8")
    } catch {
      throw new Error(`unknown fact_id: ${factId}`)
    }
    const refs = cleanExternalRefs(externalRefs)
    const newLine = "external_refs: " + dumps(refs)
    const lines = text.split("\n")
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---")
    if (close < 0) throw new Error(`malformed fact file (no frontmatter close): ${factId}`)
    const idx = lines.findIndex((line, i) => i > 0 && i < close && line.startsWith("external_refs:"))
    if (idx >= 0) lines[idx] = newLine
    else lines.splice(close, 0, newLine)
    await writeFile(p, lines.join("\n").endsWith("\n") ? lines.join("\n") : lines.join("\n") + "\n", "utf8")
    return refs
  }

  async descendants(factId: string): Promise<string[]> {
    const out: string[] = []
    const seen = new Set<string>()
    const frontier = [factId]
    const all = await this.list()
    const preds = new Map<string, string[]>()
    for (const fid of all) preds.set(fid, await this.predecessors(fid))
    while (frontier.length) {
      const cur = frontier.pop()!
      for (const fid of all) {
        if (seen.has(fid)) continue
        if ((preds.get(fid) ?? []).includes(cur)) {
          out.push(fid)
          seen.add(fid)
          frontier.push(fid)
        }
      }
    }
    return out
  }

  async undefinedSymbols(input: {
    statement: string
    proof: string
    intuition?: string
    predecessors?: string[]
    glossary_introduces?: Record<string, string>
  }): Promise<string[]> {
    const defined = new Set<string>(UNIVERSAL_TERMS)
    for (const k of Object.keys(await this.glossary())) defined.add(k)
    for (const k of Object.keys(input.glossary_introduces ?? {})) defined.add(k)
    for (const pid of input.predecessors ?? []) {
      const raw = await this.getRaw(pid)
      if (raw) {
        for (const k of Object.keys(parseFrontmatter(raw).glossary_introduces)) defined.add(k)
      }
    }
    return undefinedSymbols({
      statement: input.statement,
      proof: input.proof,
      intuition: input.intuition,
      defined,
    })
  }

  async revoke(factId: string, reason: string): Promise<string[]> {
    if (!(await this.exists(factId))) throw new Error(`unknown fact_id: ${factId}`)
    const toRevoke = [factId, ...(await this.descendants(factId))]
    await mkdir(this.revokedDir, { recursive: true })
    for (const fid of toRevoke) {
      const src = this.pathFor(fid)
      try {
        await rename(src, path.join(this.revokedDir, `${fid}.md`))
      } catch {
        continue
      }
      await appendJsonl(this.revocationLog, {
        timestamp_utc: new Date().toISOString(),
        fact_id: fid,
        reason,
        revoked_as_dependent_of: fid !== factId ? factId : null,
      })
    }
    return toRevoke
  }
}

export * as MathFactGraph from "./fact-graph"
