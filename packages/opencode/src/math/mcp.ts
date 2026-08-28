import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { createGateway, type MathGateway, type MathGatewayConfig, ToolNotFoundError } from "./gateway"
import { type MathToolName } from "./roles"
import { httpVerifier, sessionVerifier, type Verifier } from "./verifier"
import { readSwarm } from "./swarm"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "math.mcp" })

const StringMap = z.record(z.string(), z.string())

const TOOL_META: Record<
  MathToolName,
  {
    description: string
    inputSchema: Record<string, z.ZodType>
  }
> = {
  gm_add: {
    description:
      "Publish a finding to shared global memory (claim + evidence). Verifiable kinds require evidence. Judgments (plan/direction/obstacle/master_guidance/elaboration) do not. This is awareness, never a brick — proofs cite fact_id only.",
    inputSchema: {
      kind: z.string().describe("global-memory kind"),
      claim: z.string().describe("what is asserted / explored"),
      evidence: z.string().optional().describe("proof/construction, or reasoning for a judgment"),
      verifiable: z.boolean().optional(),
      glossary: StringMap.optional(),
      links: z.record(z.string(), z.unknown()).optional(),
    },
  },
  gm_search: {
    description: "BM25 over shared global-memory findings. Returns top-k per kind, never the full store.",
    inputSchema: {
      query: z.string(),
      kinds: z.array(z.string()).optional(),
      limit_per_kind: z.number().int().positive().optional(),
    },
  },
  fact_search: {
    description:
      "BM25 read view over verified facts (statement + proof + glossary), rebuilt on demand from facts/*.md. Returns top-k {fact_id, score, statement}.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().positive().optional(),
    },
  },
  fact_get: {
    description: "Read one verified active fact by exact fact_id after fact_search surfaces it.",
    inputSchema: {
      fact_id: z.string(),
    },
  },
  fact_submit: {
    description:
      "The only way to write a fact. Calls the verifier and writes the node IFF verdict=correct. Always traces the verdict to global memory (kind=verification). Orchestrator must never see this tool.",
    inputSchema: {
      statement: z.string(),
      proof: z.string(),
      predecessors: z.array(z.string()).optional(),
      glossary_introduces: StringMap.optional(),
      intuition: z.string().optional(),
      source_id: z.string().optional(),
      external_refs: z.array(z.record(z.string(), z.unknown())).optional(),
    },
  },
  fact_revoke: {
    description: "Cascade-revoke a fact and every descendant. Orchestrator only.",
    inputSchema: {
      fact_id: z.string(),
      reason: z.string(),
    },
  },
}

export function buildMathMcpServer(gateway: MathGateway): McpServer {
  const server = new McpServer({ name: "opencode-math", version: "0.1.0" })
  for (const name of gateway.tools()) {
    const meta = TOOL_META[name]
    server.registerTool(name, { description: meta.description, inputSchema: meta.inputSchema }, async (args) => {
      try {
        const result = await gateway.call(name, (args ?? {}) as Record<string, unknown>)
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
      } catch (e) {
        const message = e instanceof ToolNotFoundError ? e.message : e instanceof Error ? e.message : String(e)
        return { content: [{ type: "text" as const, text: message }], isError: true }
      }
    })
  }
  return server
}

export function verifierFromEnv(env: NodeJS.ProcessEnv = process.env): Verifier {
  const url = env.OPENCODE_MATH_VERIFY_URL
  if (url) return httpVerifier(url)
  const workspace = env.OPENCODE_MATH_WORKSPACE || process.cwd()
  return {
    async verify(input) {
      const projectModel = projectVerifierModel(env)
      const model = projectModel ?? env.OPENCODE_MATH_VERIFY_MODEL
      log.info("math verifier model selected", {
        problemID: input.problem_id,
        model,
        source: projectModel ? "project" : env.OPENCODE_MATH_VERIFY_MODEL ? "environment" : "default",
      })
      return sessionVerifier({ workspace, model }).verify(input)
    },
  }
}

export function projectVerifierModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.OPENCODE_MATH_PROJECT_DIR) return undefined
  return readSwarm(env.OPENCODE_MATH_PROJECT_DIR).verifierModel
}

export function gatewayFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<MathGatewayConfig>,
): MathGateway {
  const projectDir = overrides?.projectDir ?? env.OPENCODE_MATH_PROJECT_DIR
  if (!projectDir) throw new Error("OPENCODE_MATH_PROJECT_DIR is not set")
  return createGateway({
    projectDir,
    role: overrides?.role ?? env.OPENCODE_MATH_ROLE ?? "verifier",
    author: overrides?.author ?? env.OPENCODE_MATH_AUTHOR ?? "unknown",
    problemId: overrides?.problemId ?? env.OPENCODE_MATH_PROBLEM_ID ?? "default",
    verifier: overrides?.verifier ?? verifierFromEnv(env),
  })
}

export async function serveMathMcp(config: MathGatewayConfig): Promise<void> {
  const gateway = createGateway(config)
  const server = buildMathMcpServer(gateway)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stdin.resume()
  await new Promise<void>((resolve, reject) => {
    if (process.stdin.readableEnded) return resolve()
    const cleanup = () => {
      process.stdin.off("end", onEnd)
      process.stdin.off("error", onError)
    }
    const onEnd = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    process.stdin.once("end", onEnd)
    process.stdin.once("error", onError)
  })
}

export * as MathMcp from "./mcp"
