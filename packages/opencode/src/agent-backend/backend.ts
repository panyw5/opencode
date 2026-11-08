import type { Effect } from "effect"
import type * as Tool from "@/tool/tool"
import type { Advisor } from "@/session/external-schema"

export type AgentEvent = { id: string; kind: string; title?: string; text?: string; status?: string }
export type BackendKind = "acp" | "native-rpc" | "cli-json"
export type AgentInput = {
  prompt: string
  working_directory?: string
  model?: string
  timeout_ms?: number
}

/** The session/UI boundary. Protocol-specific lifecycle and recovery stay in the backend. */
export interface AgentBackend<P extends AgentInput = AgentInput> {
  readonly kind: BackendKind
  readonly advisor: Advisor
  execute(input: P, context: Tool.Context): Effect.Effect<Tool.ExecuteResult>
}

// Keep the proven CLI parsers and Pi's bidirectional RPC lifecycle during migration.
export function legacyBackend<P extends AgentInput>(
  advisor: Advisor,
  execute: AgentBackend<P>["execute"],
): AgentBackend<P> {
  return { advisor, kind: advisor === "pi" ? "native-rpc" : "cli-json", execute }
}
