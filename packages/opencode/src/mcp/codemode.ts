// Compatibility for the initial MCP-only integration and its callers.
export { MAX_CODE_LENGTH, DEFAULT_LIMITS, make, withAbort } from "@/session/code-mode"
export type { Entry } from "@/session/code-mode"
export * as McpCodeMode from "./codemode"
