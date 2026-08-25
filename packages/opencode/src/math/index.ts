export {
  computeFactId,
  dumps,
  normalize,
  GLOBAL_KINDS,
  STATUSES,
  cleanExternalRefs,
  type Fact,
  type GlobalKind,
} from "./schema"
export { tokenize, bm25Scores } from "./bm25"
export { mathRoot, layout, taskPath, type MathLayout } from "./layout"
export { FactGraph, serializeFact, parseFrontmatter, statementOf } from "./fact-graph"
export { GlobalMemory, type GlobalEntry } from "./global-memory"
export { toolsFor, normalizeRole, roleMay, ALL_TOOLS, type MathRole, type MathToolName } from "./roles"
export { factSubmit, type FactSubmitResult } from "./submit"
export { createGateway, ToolNotFoundError, type MathGateway, type MathGatewayConfig } from "./gateway"
export { buildMathMcpServer, serveMathMcp, gatewayFromEnv, verifierFromEnv } from "./mcp"
export { Status as MathWorkerStatusEvent } from "./event"
export {
  stubVerifier,
  missingVerifier,
  httpVerifier,
  sessionVerifier,
  decodeVerifyResult,
  parseVerifierText,
  buildVerifierPrompt,
  readVerifyInput,
  VERIFIER_OUTPUT_SCHEMA,
  VerifyUnavailableError,
  type Verifier,
  type VerifyInput,
  type VerifyResult,
  type VerificationReport,
} from "./verifier"
export { spawnDetached, pidAlive, killProcessGroup, selfArgv } from "./spawn"
export { readSwarm, writeSwarm, upsertWorker, stopPath, type SwarmFile, type SwarmWorker } from "./swarm"
export {
  startMathWorker,
  ensureMathWorker,
  discoverMathWorkers,
  statusMathWorker,
  stopMathWorker,
  runWorkerLoop,
  runWorkerRound,
  writeHeartbeat,
  buildWorkerKickoff,
  workerMcpConfig,
  latestAcceptedFactId,
  type EnsureResult,
} from "./worker"

export * as Math from "."
