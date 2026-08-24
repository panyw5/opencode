import { FactGraph } from "./fact-graph"
import { GlobalMemory } from "./global-memory"
import { type MathRole, type MathToolName, normalizeRole, toolsFor } from "./roles"
import { factSubmit } from "./submit"
import { type Verifier } from "./verifier"

export class ToolNotFoundError extends Error {
  readonly tool: string
  constructor(tool: string) {
    super(`tool not found: ${tool}`)
    this.name = "ToolNotFoundError"
    this.tool = tool
  }
}

export type MathGatewayConfig = {
  projectDir: string
  role: string
  author: string
  problemId: string
  verifier: Verifier
}

export type MathGateway = {
  readonly role: MathRole
  readonly projectDir: string
  tools(): MathToolName[]
  has(name: string): boolean
  call(name: string, args: Record<string, unknown>): Promise<unknown>
}

function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key]
  return typeof v === "string" ? v : fallback
}

function strList(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`${key} must be an array of strings`)
  }
  return v as string[]
}

function strMap(args: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${key} must be an object of strings`)
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") throw new Error(`${key}.${k} must be a string`)
    out[k] = val
  }
  return out
}

function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "boolean") throw new Error(`${key} must be a boolean`)
  return v
}

function int(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key]
  if (v === undefined || v === null) return fallback
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${key} must be a positive integer`)
  return v
}

export function createGateway(config: MathGatewayConfig): MathGateway {
  const role = normalizeRole(config.role)
  const allowed = new Set<string>(toolsFor(role))
  const factGraph = new FactGraph(config.projectDir)
  const globalMemory = new GlobalMemory(config.projectDir)

  const impl: Record<MathToolName, (args: Record<string, unknown>) => Promise<unknown>> = {
    async gm_add(args) {
      const kind = str(args, "kind")
      const claim = str(args, "claim")
      if (!kind) throw new Error("kind is required")
      if (!claim) throw new Error("claim is required")
      const id = await globalMemory.append({
        kind,
        claim,
        evidence: str(args, "evidence"),
        author: config.author,
        verifiable: bool(args, "verifiable"),
        glossary: strMap(args, "glossary"),
        links: args.links && typeof args.links === "object" && !Array.isArray(args.links) ? (args.links as Record<string, unknown>) : undefined,
      })
      return { id, kind }
    },
    async gm_search(args) {
      const query = str(args, "query")
      if (!query) throw new Error("query is required")
      return globalMemory.search(query, strList(args, "kinds"), int(args, "limit_per_kind", 10))
    },
    async fact_search(args) {
      const query = str(args, "query")
      if (!query) throw new Error("query is required")
      const results = await factGraph.search(query, int(args, "limit", 10))
      return { query, results }
    },
    async fact_submit(args) {
      const statement = str(args, "statement")
      const proof = str(args, "proof")
      if (!statement) throw new Error("statement is required")
      if (!proof) throw new Error("proof is required")
      return factSubmit(
        {
          statement,
          proof,
          predecessors: strList(args, "predecessors"),
          glossary_introduces: strMap(args, "glossary_introduces"),
          intuition: str(args, "intuition"),
          source_id: str(args, "source_id") || undefined,
          external_refs: Array.isArray(args.external_refs) ? (args.external_refs as Record<string, unknown>[]) : undefined,
        },
        {
          factGraph,
          globalMemory,
          author: config.author,
          problemId: config.problemId,
          verifier: config.verifier,
        },
      )
    },
    async fact_revoke(args) {
      const factId = str(args, "fact_id")
      const reason = str(args, "reason")
      if (!factId) throw new Error("fact_id is required")
      if (!reason) throw new Error("reason is required")
      const revoked = await factGraph.revoke(factId, reason)
      return { revoked }
    },
  }

  return {
    role,
    projectDir: config.projectDir,
    tools: () => toolsFor(role),
    has: (name) => allowed.has(name),
    async call(name, args) {
      if (!allowed.has(name) || !Object.hasOwn(impl, name)) throw new ToolNotFoundError(name)
      return impl[name as MathToolName](args)
    },
  }
}

export * as MathGateway from "./gateway"
