import { Schema } from "effect"
import { RuntimeIdentity } from "./lifecycle-state.ts"

/** Internal execution protocol, not an extension-kit compatibility promise. */
export const EXECUTION_PROTOCOL_VERSION = 1
/** Request identity scoped to one execution; no command is replayed after disconnection. */
export const RequestID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
).pipe(Schema.brand("ExtensionExecutionRequestID"))
const envelope = { version: Schema.Literal(EXECUTION_PROTOCOL_VERSION), identity: RuntimeIdentity }
/** JSON-only requests are a supervision seam, not a proxy for PluginInput, Hooks or shell. */
export const ExecutionCommand = Schema.Union([
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("request"),
    requestId: RequestID,
    method: Schema.String,
    value: Schema.Json,
  }),
  Schema.Struct({ ...envelope, type: Schema.Literal("cancel"), requestId: RequestID }),
  Schema.Struct({ ...envelope, type: Schema.Literals(["drain", "dispose"]) }),
])
export type ExecutionCommand = typeof ExecutionCommand.Type
/** Workers cannot report process exit; only the host transport can observe it. */
export const ExecutionEvent = Schema.Union([
  Schema.Struct({ ...envelope, type: Schema.Literals(["hello", "ready", "drained", "disposed"]) }),
  Schema.Struct({ ...envelope, type: Schema.Literal("result"), requestId: RequestID, value: Schema.Json }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("rejected"),
    requestId: RequestID,
    code: Schema.Literals(["closed", "cancelled", "requestFailed", "capacity"]),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("failed"),
    phase: Schema.Literals(["readiness", "dispose", "protocol"]),
  }),
])
export type ExecutionEvent = typeof ExecutionEvent.Type

/** Execution failure; uncertain stopping never grants permission to delete resources. */
export class ExecutionError extends Error {
  readonly code:
    | "protocol"
    | "readiness"
    | "closed"
    | "cancelled"
    | "requestFailed"
    | "exited"
    | "capacity"
    | "transport"
    | "deadline"
  constructor(code: ExecutionError["code"], options?: ErrorOptions) {
    super(`Extension execution failed: ${code}`, options)
    this.name = "ExtensionExecutionError"
    this.code = code
  }
}

/**
 * Decode a worker event at the process boundary, including unknown-field rejection.
 * @param input Parsed JSON frame from the control channel.
 * @returns Valid protocol event; invalid versions and non-JSON payloads fail closed.
 */
export function decodeExecutionEvent(input: unknown): ExecutionEvent {
  try {
    return Schema.decodeUnknownSync(ExecutionEvent)(input, { onExcessProperty: "error" })
  } catch (cause) {
    throw new ExecutionError("protocol", { cause })
  }
}

/**
 * Decode a host command before dispatching any worker action.
 * @param input Parsed JSON frame from the control channel.
 * @returns Valid protocol command or a structured protocol failure.
 */
export function decodeExecutionCommand(input: unknown): ExecutionCommand {
  try {
    return Schema.decodeUnknownSync(ExecutionCommand)(input, { onExcessProperty: "error" })
  } catch (cause) {
    throw new ExecutionError("protocol", { cause })
  }
}

export * as ExecutionProtocol from "./execution-protocol.ts"
