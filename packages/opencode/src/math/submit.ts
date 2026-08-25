import { FactGraph } from "./fact-graph"
import { GlobalMemory } from "./global-memory"
import { type ExternalRef } from "./schema"
import { type Verifier, VerifyUnavailableError } from "./verifier"

export type FactSubmitInput = {
  statement: string
  proof: string
  predecessors?: string[]
  glossary_introduces?: Record<string, string>
  intuition?: string
  source_id?: string
  external_refs?: ExternalRef[]
}

export type FactSubmitResult =
  | {
      accepted: true
      fact_id: string
      undefined_symbols: string[]
    }
  | {
      accepted: true
      fact_id: null
      write_error: string
      undefined_symbols: string[]
    }
  | {
      accepted: false
      verdict: "wrong"
      repair_hints?: string
      verification_report?: unknown
      undefined_symbols: string[]
    }
  | {
      accepted: false
      verdict: "error"
      error: string
      undefined_symbols: string[]
    }

export async function factSubmit(
  input: FactSubmitInput,
  ctx: {
    factGraph: FactGraph
    globalMemory: GlobalMemory
    author: string
    problemId: string
    verifier: Verifier
  },
): Promise<FactSubmitResult> {
  let undefinedSyms: string[] = []
  try {
    undefinedSyms = await ctx.factGraph.undefinedSymbols({
      statement: input.statement,
      proof: input.proof,
      intuition: input.intuition,
      predecessors: input.predecessors,
      glossary_introduces: input.glossary_introduces,
    })
  } catch {
    undefinedSyms = []
  }

  let result: Awaited<ReturnType<Verifier["verify"]>>
  try {
    const predecessors = input.predecessors ?? []
    const predecessor_facts = await Promise.all(
      predecessors.map(async (fact_id) => ({ fact_id, content: (await ctx.factGraph.getRaw(fact_id)) ?? "" })),
    )
    result = await ctx.verifier.verify({
      problem_id: ctx.problemId,
      statement: input.statement,
      proof: input.proof,
      predecessors,
      predecessor_facts,
      glossary: await ctx.factGraph.glossary(),
    })
  } catch (e) {
    const error = e instanceof VerifyUnavailableError || e instanceof Error ? e.message : String(e)
    return { accepted: false, verdict: "error", error, undefined_symbols: undefinedSyms }
  }

  const accepted = result.verdict === "correct"
  let factId: string | null = null
  let writeError: string | undefined
  if (accepted) {
    try {
      factId = await ctx.factGraph.add({
        problem_id: ctx.problemId,
        author: ctx.author,
        statement: input.statement,
        proof: input.proof,
        predecessors: input.predecessors,
        glossary_introduces: input.glossary_introduces,
        intuition: input.intuition,
        external_refs: input.external_refs,
      })
    } catch (e) {
      writeError = e instanceof Error ? e.message : String(e)
    }
  }

  await ctx.globalMemory.append({
    kind: "verification",
    claim: input.statement,
    evidence: accepted ? "verdict: correct" : result.repair_hints || "verdict: wrong",
    author: ctx.author,
    verifiable: false,
    links: { source_id: input.source_id ?? null, predecessors: input.predecessors ?? [] },
    extra: {
      verdict: result.verdict,
      fact_id: factId,
      write_error: writeError ?? null,
      verification_report: result.verification_report ?? null,
    },
  })

  if (!accepted) {
    return {
      accepted: false,
      verdict: "wrong",
      repair_hints: result.repair_hints,
      verification_report: result.verification_report,
      undefined_symbols: undefinedSyms,
    }
  }
  if (writeError) {
    return { accepted: true, fact_id: null, write_error: writeError, undefined_symbols: undefinedSyms }
  }
  return { accepted: true, fact_id: factId!, undefined_symbols: undefinedSyms }
}

export * as MathSubmit from "./submit"
